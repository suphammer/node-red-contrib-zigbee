/* eslint-env node */
/* eslint indent:0,semi:0, no-console: 0 */
/* jshint devel: true, node: true*/
/* global: */

/***
 * Start an instance of Node-Red under Express.JS
 *
 * Allows multiple instances of Node-Red to be run, even different versions in parallel.
 ***/

"use strict" /* always for Node.JS, never global in the browser */;

// logging ************
// you should consider using the packages debug and console-stamp to
// incorporate standard logging with node-red logging

// The TCP port for this systems web interface - picked up from env, package.json or fixed value
const http_port =
  process.env.HTTPPORT || process.env.npm_package_config_http_port || 1880;
const use_https =
  process.env.USEHTTPS ||
  process.env.npm_package_config_use_https == "true" ||
  false;
const listening_address =
  process.env.LISTENINGADDRESS ||
  process.env.npm_package_config_listening_address ||
  "0.0.0.0";

const http = use_https ? require("https") : require("http");

const express = require("express"); // THE std library for serving HTTP
const RED = require("node-red");
const fs = require("fs");

// Create an Express app
var app = express();

// Add a simple route for static content served from './public'
app.use("/", express.static("./public"));

// Create the http(s) server
if (use_https) {
  var privateKey = fs.readFileSync("./server.key", "utf8");
  var certificate = fs.readFileSync("./server.crt", "utf8");
  var credentials = {
    key: privateKey,
    cert: certificate
  };
}
var httpServer = use_https
  ? http.createServer(credentials, app)
  : http.createServer(app);

var settings = {
  httpAdminRoot: "/admin",
  httpNodeRoot: "/",
  userDir: "./.nodered",
  nodesDir: "./nodes",
  logging: {
	console: {
		level: "debug"
	}
  }
};

// Initialise the runtime with a server and settings
// @see http://nodered.org/docs/configuration.html
RED.init(httpServer, settings);
app.use(settings.httpAdminRoot, RED.httpAdmin);
app.use(settings.httpNodeRoot, RED.httpNode);

httpServer.listen(http_port, listening_address, function() {
  console.info(
    "Express 4 https server listening on http%s://%s:%d%s, serving node-red",
    use_https ? "s" : "",
    httpServer.address().address.replace("0.0.0.0", "localhost"),
    httpServer.address().port,
    settings.httpAdminRoot
  );
});
// Start the runtime
RED.start().then(function() {
  console.info("------ Engine started! ------");
});
