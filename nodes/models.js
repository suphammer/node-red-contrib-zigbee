const fz = require('zigbee-herdsman-converters/converters/fromZigbee');
const tz = require('zigbee-herdsman-converters/converters/toZigbee');
const exposes = require('zigbee-herdsman-converters/lib/exposes');
const reporting = require('zigbee-herdsman-converters/lib/reporting');
const extend = require('zigbee-herdsman-converters/lib/extend');
const e = exposes.presets;
const ea = exposes.access;

const definitions = [
	{
		zigbeeModel: ['HT-BPRDW-2'],
        model: 'HT-BPRDW-2',
        vendor: 'Heimgard Technologies',
        description: 'Wattle door lock pro 3',
		fromZigbee: [ fz.command_move_to_level ],
		exposes: [ e.light_brightness() ],
	}
];

module.exports = definitions;
