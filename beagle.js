var fs = require('fs'),
    http = require('http'),
    path = require('path'),
    util = require('util'),
    exec = require('child_process').exec,
    child_process = require('child_process'),
    utils = require(__dirname+'/lib/client-utils.js'),
    Inotify = require('inotify-plusplus'),
    serialport = require('serialport'),
    SerialPort = serialport.SerialPort,
    sendIv = 0,
    watchDogIv,
    rebootIv,
    inotify,
    tty,
    directive,
    cameraIv,
    cameraGuid,
    config =  {
        client:'beagle',
        nodeVersion:0.7,
        systemVersion:0.4,
        cloudHost: 'zendo.ninja.is',
        cloudStream: 'stream.ninja.is',
        cloudStreamPort: 443,
        cloudPort: 443,
        devtty: "/dev/ttyO1",
        serialFile: "/etc/opt/ninja/serial.conf",
        tokenFile: "/etc/opt/ninja/token.conf",
        updateLock: '/etc/opt/ninja/.has_updated',
        heartbeat_interval: 2000,
        secure:true
    };
    config.id=fs.readFileSync(config.serialFile).toString().replace(/\n/g,'');
    config.utilitiesVersion=(path.existsSync('/opt/utilities/version'))
        ? parseFloat(fs.readFileSync('/opt/utilities/version'))
        : 0.4;

console.log(utils.timestamp()+' Ninja Block Starting Up');

/*
    Fetch the arduino model and version
 */
child_process.execFile('/opt/utilities/bin/fetch_arduino_version',function(code,stdout,stderr) {
    if (stdout && stdout.indexOf('_')>-1) {
        var parts = stdout.split('_');
        config.arduinoModel = parts[0];
        config.arduinoVersion = parseFloat(parts[1]);
    } else if (stdout && stdout.lenght>0) {
        config.arduinoModel = 'V11';
        config.arduinoVersion = 0.36
    }
});
// We give 3 seconds to try and grab the arduino version
setTimeout(function() {
    // Setup the TTY serial port
    tty = new SerialPort(config.devtty, { 
        parser: serialport.parsers.readline("\n")
    });
    utils.configure(config,tty);
    var up = upnode(clientHandlers).connect(connectionParams);
    up.on('up',function (remote) {
        console.log(utils.timestamp()+' All Systems Go');
        tty.removeAllListeners('data');
        tty.on('data',function(data){
            utils.handleRawTtyData(data);
        });
        exec('/opt/utilities/bin/reset_arduino',function(code,stdout,stderr) {
            utils.changeLEDColor('green');
        });
        utils.remote = remote;
        // Reset arduino
        clearInterval(sendIv);
        sendIv = setInterval(function(){
            remote.heartbeat(utils.getHeartbeat());
        },config.heartbeat_interval); 
    });
    up.on('reconnect',function() {
        utils.changeLEDColor('cyan');
        console.log(utils.timestamp()+' Reconnecting');
    });
},3000);

// Development overwrites
if (process.argv[2] == 'local') {
    config.cloudHost = process.argv[3];
    config.cloudPort = 3001;
    config.cloudStream = process.argv[3];
    config.cloudStreamPort = 3003;
    config.secure = false;
};

// Connect
// up down reconnect reconnect reconnect up
var upnode = require('upnode');
var proto = (config.secure) ? require('tls') : require('net');
var connectionParams = {
    ping:10000,
    timeout:5000,
    reconnect:2000,
    createStream:function () {
        return proto.connect(config.cloudPort, config.cloudHost);
    },
    block: function (remote, conn) {
        var params = {
            client:config.client,
            id:config.id,
            version:{
                node:config.nodeVersion,
                utilities:config.utilitiesVersion,
                system:config.systemVersion,
                arduino: {
                    model:config.arduinoModel,
                    version:config.arduinoVersion
                }
            }
        };
        console.log(params);
        var token = utils.fetchBlockToken();
        if (token) {
            utils.changeLEDColor('cyan');
            console.log(utils.timestamp()+' Connecting');
            remote.handshake(params, token, function (err, res) {
                if (err) console.error(utils.timestamp()+" "+err);
                else {
                    conn.emit('up',res);
                }
            });
        } else {
            // Short term hack to make sure it goes purple
            setTimeout(function() {
                utils.changeLEDColor('purple');
            },100);
            console.log(utils.timestamp()+' Awaiting Activation');
            remote.activate(params,function(err,auth) {
                if (err||!auth) {
                    console.log(utils.timestamp()+" Error, Restarting");
                    process.exit(1)
                } else {
                    console.log(utils.timestamp()+" Received Authorisation, Confirming");
                    fs.writeFile(config.tokenFile, auth.token, 'utf8',function(err) {
                        if (err) throw err;
                        else {
                            params.token=auth.token;
                            remote.confirmActivation(params,function(err) {
                                if (err) {
                                    console.log(utils.timestamp()+" Error pairing block.")
                                    fs.unlinkSync(config.tokenFile);
                                } else {
                                    console.log(utils.timestamp()+" Confirmed Authorisation, Restarting");
                                }
                                process.exit(1);
                            });
                        }
                    });
                }
            });
        }
    }
};
var clientHandlers = {
    revokeCredentials: function() {
        console.log(utils.timestamp()+" Invalid Token, Restarting");
        // Delete token
        fs.unlinkSync(config.tokenFile);
        // Restart
        process.exit(1);
    },
    execute: function(command,fn) {
        if (utils.executeCommand(command)) {
            fn(null);   // Executed successfully
        } else {
            fn(true);   // Error executing
        }
    },
    update: function(toUpdate) {
        console.log(utils.timestamp()+" Updating");
        if (typeof toUpdate !== "object"
            || !(toUpdate instanceof Array)) return false;
        else utils.updateCode(toUpdate);
    }
};

// Camera
inotify = Inotify.create(true); // stand-alone, persistent mode, runs until you hit ctrl+c
directive = (function() {
    return {
      create: function (ev) {
        if(ev.name == 'v4l'){
            cameraGuid = utils.buildDeviceGuid(config.id,{G:"0",V:0,D:1004});
            clearInterval(cameraIv);
            cameraIv = setInterval(function() {
                utils.readings[cameraIv] = {
                    GUID:cameraGuid,
                    G:"0",
                    V:0,
                    D:1004,
                    DA:"1"
                };
            },config.heartbeat_interval);
        }
      },
      delete: function(ev) {
        if(ev.name == 'v4l'){
            clearInterval(cameraIv);
        }
      }
    };
}());
inotify.watch(directive, '/dev/');
try {
    // Query the entry
    var stats = fs.lstatSync('/dev/video0');
    // Is it a directory?
    if (stats.isCharacterDevice()) {
        // Yes it is
        console.log(utils.timestamp()+" Camera is Connected");
        cameraGuid = utils.buildDeviceGuid(config.id,{G:"0",V:0,D:1004});
        cameraIv = setInterval(function() {
            utils.readings[cameraIv] = {
                GUID:cameraGuid,
                G:"0",
                V:0,
                D:1004,
                DA:"1"
            };
        },config.heartbeat_interval);
    }
}
catch (e) {
    console.log(utils.timestamp()+" Camera Not Present");
}
// Watdog Timer
/*
var watchDogStream = fs.open('/dev/watchdog','r+',function(err,fd) {
    if (err) console.log(utils.timestamp()+" "+err);
    var watchDogPayload = new Buffer(1);
    watchDogPayload.write('\n','utf8');
    watchDogIv = setInterval(function() {
        fs.write(fd,watchDogPayload,0, watchDogPayload.length, -1,function(err) {
            if (err) console.log(utils.timestamp()+" "+err);
        });
    },30000);
    utils.watchDogIv=watchDogIv;
});
 */
// Process event handlers
/*
process.on('exit',function() {
    utils.changeLEDColor('yellow');
});
process.on('SIGINT',function() {
    // Ctrl + C
});
process.on('uncaughtException',function(err) {
    // Unknown error
    console.log(err);
    process.exit(1);
});
*/
