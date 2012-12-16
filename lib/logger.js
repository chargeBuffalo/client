var 
	util = require('util')
	, fs = require('fs')
;

// TODO: add sprintf support to log messages.

function logger(opts) {
	
	this.opts = opts || { };
	this.stream = undefined;

	this.createStream();

	return this;
};


logger.prototype.streamError = function streamError(err) {
	
	console.log("%s (ERROR) Stream error in logger. %s", now(), err);
};

logger.prototype.createStream = function createStream() {

	/**
	 * Only supporting local logging for now.
	 */
	if(!this.opts.logFile) {

		return false;
	}

	this.stream = fs.createWriteStream(this.opts.logFile, {

		flags : 'a'
		, encoding : 'utf8'
		, mode : this.opts.logPerms || 0600
	});

	var myLogger = this;
	this.stream.on('error', function(err) {

		myLogger.streamError(err);
		setTimeout(function reStream() {

			myLogger.createStream.call(myLogger);
		}, 5000);
	});

	return this.stream || undefined;
};

logger.prototype.log = function log() {
	
	/**
	 * Log something with a timestamp
	 */
	var args = Array.prototype.slice.call(arguments);
	var type = args.shift();
	var l = util.format.apply(null, args);
	var str = [ now(), type, l ].join(' ');
	this.stream.write(str+"\n");
	console.log(str);

};

logger.prototype.debug = function debug() {

	if(this.opts.env != "development") { return; }

	this.msg.call(this, 'DEBUG', arguments);
};

logger.prototype.info = function info() {

	if(this.opts.env == "production") { return; }

	this.msg.call(this, 'info', arguments);
};

logger.prototype.error = function error() {

	this.msg.call(this, 'ERROR', arguments);
};

logger.prototype.warn = function warn() {

	this.msg.call(this, 'warn', arguments);
};

logger.prototype.msg = function msg(type, args) {

	var args = Array.prototype.slice.call(args);
	args.unshift('('+(type || 'info')+')');
	this.log.apply(this, args);
};

function now() {

	return '['+(new Date()).toUTCString()+']';
}

module.exports = logger;