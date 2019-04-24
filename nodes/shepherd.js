const fs = require('fs');
const path = require('path');
const {EventEmitter} = require('events');

const mkdirp = require('mkdirp');
const Shepherd = require('zigbee-shepherd');

const interval = require('../interval.json');

const devices = {};
const shepherdNodes = {};
const shepherdInstances = {};

module.exports = function (RED) {
    RED.httpAdmin.get('/zigbee-shepherd/devices', (req, res) => {
        res.status(200).send(JSON.stringify(devices[req.query.id] || {}));
    });

    RED.httpAdmin.get('/zigbee-shepherd/graphviz', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].shepherd.lqiScan(shepherdNodes[req.query.id].shepherd.controller._coord.ieeeAddr)
                .then(topology => {
                    let text = 'digraph G {\nnode[shape=record];\n';
                    Object.keys(shepherdNodes[req.query.id].devices).forEach(ieeeAddr => {
                        console.log(ieeeAddr);
                        const device = shepherdNodes[req.query.id].devices[ieeeAddr];
                        const labels = [];
                        labels.push(ieeeAddr);
                        labels.push(device.name);
                        labels.push(device.manufName);
                        labels.push(device.modelId);
                        labels.push(device.powerSource);
                        labels.push('overdue=' + device.overdue + ' status=' + device.status)
                        let devStyle;

                        if (device.type == 'Coordinator') {
                            devStyle = 'style="bold"';
                        } else if (device.type == 'Router') {
                            devStyle = 'style="rounded"';
                        } else {
                            devStyle = 'style="rounded, dashed"';
                        }
                        text += `  "${device.ieeeAddr}" [${devStyle}, label="{${labels.join('|')}}"];\n`;


                        topology.filter((e) => e.ieeeAddr === device.ieeeAddr).forEach((e) => {
                            const lineStyle = (e.lqi==0) ? `style="dashed", ` : ``;
                            text += `  "${device.ieeeAddr}" -> "${e.parent}" [`+lineStyle+`label="${e.lqi}"]\n`;
                        });
                    });
                    text += '}';
                    res.status(200).send(text.replace(/\0/g, ''));
                });
        } else {
            res.status(500).send('');
        }
    });

    RED.httpAdmin.post('/zigbee-shepherd/names', (req, res) => {
        if (devices[req.query.id]) {
            Object.keys(req.body).forEach(addr => {
                devices[req.query.id][addr].name = req.body[addr];
            });
            shepherdNodes[req.query.id].save();
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/remove', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].remove(req.query.addr);
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/join', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].join(parseInt(req.query.time, 10) || 0, req.query.type || 'all');
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/bind', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].bind(req.query.deviceSrc, parseInt(req.query.epSrc, 10), req.query.deviceDest, parseInt(req.query.epDest, 10), req.query.groupDest, req.query.cId);
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/unbind', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            shepherdNodes[req.query.id].unbind(req.query.deviceSrc, parseInt(req.query.epSrc, 10), req.query.deviceDest, parseInt(req.query.epDest, 10), req.query.groupDest, req.query.cId);
        }

        res.status(200).send('');
    });

    RED.httpAdmin.get('/zigbee-shepherd/join-time-left', (req, res) => {
        if (shepherdNodes[req.query.id]) {
            res.status(200).send(JSON.stringify({joinTimeLeft: shepherdNodes[req.query.id].joinTimeLeft}));
        } else {
            res.status(200).send(JSON.stringify({joinTimeLeft: 0}));
        }
    });

    class ShepherdProxy extends EventEmitter {
        constructor(shepherdNode) {
            super();

            this.setMaxListeners(1000);

            this.shepherdNode = shepherdNode;
            this.shepherd = shepherdNode.shepherd;

            this.queueMaxWait = 5000;
            this.queueMaxLength = 50;
            this.queuePause = 100;
            this.commandQueue = [];

            this.trace = shepherdNode.trace;
            this.debug = shepherdNode.debug;
            this.log = shepherdNode.log;
            this.warn = shepherdNode.warn;
            this.error = shepherdNode.error;
        }

        queue(cmd, timeout) {
            const {length} = this.commandQueue;
            this.commandQueue = this.commandQueue.filter(q => {
                const c = q.cmd;
                const cmdZclDataKeys = Object.keys(cmd.zclData);
                return (
                    c.ieeeAddr !== cmd.ieeeAddr ||
                    c.ep !== cmd.ep ||
                    c.cmdType !== cmd.cmdType ||
                    c.cmd !== cmd.cmd ||
                    !Object.keys(c.zclData).every(key => cmdZclDataKeys.includes(key))
                );
            });

            this.trace('dropped ' + (length - this.commandQueue.length) + ' queued commands');

            if (this.commandQueue.length < this.queueMaxLength) {
                this.commandQueue.push({cmd, timeout});
                this.shiftQueue();
            } else {
                this.error('maximum commandQueue length exceeded, ignoring command');
            }
        }

        shiftQueue() {
            if ((this.commandQueue.length > 0) && !this.cmdPending) {
                this.cmdPending = true;
                const {cmd, timeout} = this.commandQueue.shift();

                const endpoint = this.shepherd.find(cmd.ieeeAddr, cmd.ep);

                if (!endpoint) {
                    this.error('endpoint not found ' + cmd.ieeeAddr + ' ' + cmd.ep);
                    if (typeof cmd.callback === 'function') {
                        cmd.callback(new Error('endpoint not found'));
                    }

                    this.cmdPending = false;
                    this.shiftQueue();
                    return;
                }

                this.debug(JSON.stringify(cmd));
                const start = (new Date()).getTime();

                cmd.cmdType = cmd.cmdType || 'foundation';

                switch (cmd.cmdType) {
                    case 'foundation':
                    case 'functional':
                        if (cmd.cfg && cmd.cfg.disDefaultRsp) {
                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg);
                            setTimeout(() => {
                                this.cmdPending = false;
                                this.shiftQueue();
                            }, this.queuePause);
                        } else {
                            const timer = setTimeout(() => {
                                this.debug('timeout! ' + timeout + ' ' + this.queueMaxWait);
                                if (typeof cmd.callback === 'function') {
                                    cmd.callback(new Error('timeout'));
                                    delete cmd.callback;
                                }

                                if (!cmd.disBlockQueue) {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }
                            }, timeout || this.queueMaxWait);

                            endpoint[cmd.cmdType](cmd.cid, cmd.cmd, cmd.zclData, cmd.cfg, (err, res) => {
                                clearTimeout(timer);
                                if (!cmd.disBlockQueue) {
                                    const elapsed = (new Date()).getTime() - start;
                                    const pause = elapsed > this.queuePause ? 0 : (this.queuePause - elapsed);
                                    setTimeout(() => {
                                        this.cmdPending = false;
                                        this.shiftQueue();
                                    }, pause);
                                    this.debug('elapsed ' + elapsed + ' ms -> wait ' + pause + 'ms');
                                }

                                if (typeof cmd.callback === 'function') {
                                    cmd.callback(err, res);
                                }
                            });
                            if (cmd.disBlockQueue) {
                                setTimeout(() => {
                                    this.cmdPending = false;
                                    this.shiftQueue();
                                }, this.queuePause);
                            }
                        }

                        break;

                    default:
                        this.error('cmdType ' + cmd.cmdType + ' not supported');
                        this.cmdPending = false;
                        this.shiftQueue();
                }
            }
        }
    }

    class ZigbeeShepherd {
        constructor(config) {
            RED.nodes.createNode(this, config);

            this.persistPath = path.join(RED.settings.userDir, 'zigbee', this.id);
            this.log('persistPath ' + this.persistPath);
            if (!fs.existsSync(this.persistPath)) {
                this.log('mkdirp ' + this.persistPath);
                mkdirp.sync(this.persistPath);
            }

            this.namesPath = path.join(this.persistPath, 'names.json');
            this.dbPath = path.join(this.persistPath, 'dev.db');
            this.led = config.led;

            shepherdNodes[this.id] = this;

            try {
                devices[this.id] = JSON.parse(fs.readFileSync(this.namesPath).toString());
            } catch (error) {
                this.warn(error);
            }

            if (!devices[this.id]) {
                devices[this.id] = {};
            }

            this.devices = devices[this.id];

            let precfgkey;
            if (this.credentials.precfgkey) {
                const bytes = this.credentials.precfgkey.match(/[0-9a-fA-F]{2}/gi);
                precfgkey = bytes.map(t => parseInt(t, 16));
            }

            let panId = 0xFFFF;
            if (this.credentials.panId) {
                panId = parseInt(this.credentials.panId, 16);
            }

            const shepherdOptions = {
                sp: {
                    baudRate: parseInt(config.baudRate, 10) || 115200,
                    rtscts: Boolean(config.rtscts)
                },
                net: {
                    panId,
                    precfgkey,
                    channelList: config.channelList
                },
                dbPath: this.dbPath
            };

            if (!shepherdInstances[this.id]) {
                shepherdInstances[this.id] = new Shepherd(config.path, shepherdOptions);
            }

            this.shepherd = shepherdInstances[this.id];

            this.proxy = new ShepherdProxy(this);

            //this.shepherd = new Shepherd(config.path, shepherdOptions);

            const listeners = {
                ready: () => this.readyHandler(),
                error: error => this.errorHandler(error),
                ind: msg => this.indHandler(msg),
                permitJoining: joinTimeLeft => this.permitJoiningHandler(joinTimeLeft)
            };

            Object.keys(listeners).forEach(event => {
                this.shepherd.on(event, listeners[event]);
            });

            this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'starting'});
            this.debug('starting ' + config.path + ' ' + JSON.stringify(shepherdOptions));
            this.shepherd.start(error => {
                if (error) {
                    this.proxy.emit('nodeStatus', {fill: 'red', shape: 'ring', text: error.message + ', retrying'});
                    this.error(error.message + ', retrying');
                    this.shepherd.controller._znp.close((() => null));

                    setTimeout(() => {
                        this.shepherd.start(error => {
                            if (error) {
                                this.proxy.emit('nodeStatus', {fill: 'red', shape: 'dot', text: error.message});
                                this.error(error.message);
                            } else {
                                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                                this.debug('started');
                            }
                        });
                    }, 60000);
                } else {
                    this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'dot', text: 'connecting'});
                    this.debug('started');
                }
            });

            const checkOverdueInterval = setInterval(() => {
                this.checkOverdue();
            }, 60000);

            this.on('close', done => {
                this.debug('stopping');
                clearInterval(checkOverdueInterval);
                this.proxy.emit('nodeStatus', {fill: 'yellow', shape: 'ring', text: 'closing'});
                this.shepherd.stop(() => {
                    Object.keys(listeners).forEach(event => {
                        this.shepherd.removeListener(event, listeners[event]);
                    });
                    this.proxy.emit('nodeStatus', {});
                    setTimeout(() => {
                        this.proxy.removeAllListeners();
                        this.trace('removed event listeners');
                        this.debug('stopped shepherd');
                        done();
                    }, 100);
                });
            });
        }

        readyHandler() {
            this.log('ready');
            this.list();
            const now = (new Date()).getTime();
            Object.keys(this.devices).forEach(ieeeAddr => {
                this.devices[ieeeAddr].ts = now;
                delete this.devices[ieeeAddr].overdue;
            });
            this.proxy.emit('ready');
            this.proxy.emit('nodeStatus', {fill: 'green', shape: 'dot', text: 'connected'});
            this.shepherd.controller.request('UTIL', 'ledControl', {ledid: 3, mode: this.led === 'enabled' ? 1 : 0});
        }

        errorHandler(error) {
            this.error(error);
            //this.proxy.emit('error', error);
        }

        indHandler(msg) {
            const now = (new Date()).getTime();
            let ieeeAddr;

            if (msg.type === 'devIncoming' || msg.type === 'devLeaving') {
                ieeeAddr = msg.data;
                this.debug(msg.type + ' ' + msg.data);
                this.list();
            } else {
                const firstEp = (msg && msg.endpoints && msg.endpoints[0]) || {};
                ieeeAddr = firstEp.device && firstEp.device.ieeeAddr;
            }

            if (this.devices[ieeeAddr]) {
                this.devices[ieeeAddr].ts = now;
                if (this.devices[ieeeAddr].overdue !== false) {
                    this.debug('overdue false ' + ieeeAddr + ' ' + this.devices[ieeeAddr].name);
                    this.devices[ieeeAddr].overdue = false;
                    this.proxy.emit('devices', this.devices);
                }
            }

            this.proxy.emit('ind', msg);
        }

        permitJoiningHandler(joinTimeLeft) {
            if (joinTimeLeft < 0) {
                this.join(1);
            }

            this.proxy.emit('permitJoining', joinTimeLeft);
            this.joinTimeLeft = joinTimeLeft;
        }

        save() {
            fs.writeFile(this.namesPath, JSON.stringify(this.devices, null, '  '), () => {});
        }

        list(addr) {
            const known = [];
            let change = false;
            this.shepherd.list(addr).forEach(dev => {
                known.push(dev.ieeeAddr);
                if (!this.devices[dev.ieeeAddr]) {
                    change = true;
                    this.devices[dev.ieeeAddr] = {name: ''};
                }

                Object.assign(this.devices[dev.ieeeAddr], dev);
            });
            Object.keys(this.devices).forEach(addr => {
                if (!known.includes(addr)) {
                    change = true;
                    delete this.devices[addr];
                }
            });
            if (change) {
                this.save();
                this.debug('list: changed!');
            } else {
                this.debug('list: no change');
            }

            this.proxy.emit('devices', this.devices);
        }

        remove(addr) {
            this.log('remove ' + addr);
            this.shepherd.remove(addr, {reJoin: true, rmChildren: false}, error => {
                if (error) {
                    this.error('remove ' + addr + ' ' + error);
                }
            });
        }

        join(time, type) {
            this.log('permitJoin ' + time + ' ' + type);
            if (time) {
                this.shepherd.permitJoin(time, type);
            } else {
                this.shepherd.permitJoin(1, type);
            }
        }

        bind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            console.log('bind', deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster);
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('source endpoint ' + deviceSrc + ' ' + epSrc + ' unkown');
                return;
            }

            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('destination endpoint ' + deviceDest + ' ' + epDest + ' unkown');
                return;
            }

            endpointSrc.bind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('bind successful');
                }
            });
        }

        unbind(deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster) {
            console.log('unbind', deviceSrc, epSrc, deviceDest, epDest, groupDest, cluster);
            const endpointSrc = this.shepherd.find(deviceSrc, epSrc);
            if (!endpointSrc) {
                this.error('source endpoint ' + deviceSrc + ' ' + epSrc + ' unkown');
                return;
            }

            const endpointDest = Number(groupDest) || this.shepherd.find(deviceDest, epDest);
            if (!endpointDest) {
                this.error('destination endpoint ' + deviceDest + ' ' + epDest + ' unkown');
                return;
            }

            endpointSrc.unbind(cluster, endpointDest, err => {
                if (err) {
                    this.error(err.message);
                } else {
                    this.log('unbind successful');
                }
            });
        }

        checkOverdue() {
            const now = (new Date()).getTime();
            let change = false;
            Object.keys(this.devices).forEach(ieeeAddr => {
                 const elapsed = Math.round((now - this.devices[ieeeAddr]) / 60000);
                 const timeout = interval[this.devices[ieeeAddr].modelId];
                 if (timeout && (elapsed > timeout) && (this.devices[ieeeAddr].overdue !== true)) {
                     change = true;
                     this.debug('overdue true ' + ieeeAddr + ' ' + this.devices[ieeeAddr].name);
                     this.devices[ieeeAddr].overdue = true;
                 }
            });
            if (change) {
                this.proxy.emit('devices', this.devices);
            }
        }
    }

    RED.nodes.registerType('zigbee-shepherd', ZigbeeShepherd, {
        credentials: {
            panId: {type: 'text'},
            precfgkey: {type: 'text'}
        }
    });
};
