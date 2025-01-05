require('dotenv').config();
const fs = require('fs');
const request = require('request');
const execSync = require('child_process').execSync;
const execAsync = require('child_process').exec;
const express = require('express');

const server = express();
const port = parseInt(process.env.PORT);
const checkInterval = parseInt(process.env.RUN_INTERVAL);
const allowedLoginAttemps = parseInt(process.env.ALLOWED_LOGIN_ATTEMPTS);
const allowedRestartAttempts = parseInt(process.env.ALLOWED_RESTART_ATTEMPTS);
const ignoredLogLevels = process.env.IGNORED_LOG_LEVELS.toUpperCase().split(',');
const serverUrl = process.env.SERVER_URL || `http://${process.env.SERVER_LOCAL_IP}:${port}`;
const start = getTimestamp();

const statuses = {RUNNING: 'RUNNING', STOPPED: 'STOPPED', REBOOTING: 'REBOOTING'};
const runState = {SKIPPED: 'Skipped due to non-running status', UNAUTHENTICATED: 'Unauthenticated (re-logging into router)', FOUND_EXTERNAL: 'External IP found (no operation)', FOUND_INTERNAL: 'Internal IP found (rebooting router)'};

let restartAttempts = 0;
let loginAttempts = 0;
let authenticated = false;

let status;
let statusUpdateTime;
let lastIp;
let lastIpTimestamp;
let lastRunState;
let lastRunAttemptTimestamp;
let lastReboot = '-';

server.get('/', (req, res) => {
  res.set('Content-Type', 'text/html');
  res.send(
    `Netgear Rebooter Status: <b>${status}</b> (Since ${statusUpdateTime})<br/><br/>` +
    `Last IP found: <b>${lastIp}</b> [ ${lastIpTimestamp} ]<br/><br/>` + 
    `Last run state: <b>${lastRunState}</b> [ ${lastRunAttemptTimestamp} ]<br/><br/>` + 
    `Last router reboot: <b>${lastReboot}</b><br/><br/>` +
    `Restart attempts: ${restartAttempts} (Limit: ${allowedRestartAttempts})<br/>` +
    `Login attempts: ${loginAttempts} (Limit: ${allowedLoginAttemps})<br/><br/>` +
    `<button type="submit" onclick="location.href='${serverUrl}/restart'">Restart</button><br/><br/>` +
    `Server started at ${start}`
  );
});

server.get('/restart', (req, res) => {
  let responseText;
  if (status === statuses.STOPPED) {
    responseText = `Restarted! Status updated [${status} -> ${statuses.RUNNING}]`;
    updateStatus(statuses.RUNNING);
    restartAttempts = 0;
    loginAttempts = 0;
  } else {
    responseText = `Did not restart, status [${statuses.RUNNING}] does not allow restarting, try again later`;
  }
  res.send(`${responseText}<br/><br/><button type="submit" onclick="location.href='${serverUrl}'">Home</button>`);
});

server.listen(port, () => {
  console.log(`Running at ${serverUrl}`);
});

const checkExternalIP = () => {
  lastRunAttemptTimestamp = getTimestamp();
  if (status === statuses.RUNNING) {
    const endpoint = `http://${process.env.NETGEAR_USER}:${process.env.NETGEAR_PASS}@${process.env.NETGEAR_IP}/ADVANCED_home2.htm`;
    request(endpoint, function (error, response, body) {
      if (error || (response && response.statusCode !== 200)) {
        lastRunState = runState.FOUND_EXTERNAL;
        authenticated = false;
        log('Unauthenticated - logging into router');
        if (loginAttempts++ >= allowedLoginAttemps) {
          log('Too many failed login attempts - Shutting down', 'WARN');
          updateStatus(statuses.STOPPED);
        }
        execSync(`wget -qO- ${endpoint} &> /dev/null`); // hack to get the netgear auth token (wget handles auth for server)
        setTimeout(checkExternalIP, 1000);
      } else {
        if (!authenticated) {
          log('Login successful');
          authenticated = true;
          loginAttempts = 0;
        }
        const ip = body.match(/\b\d+\.\d+\.\d+\.\d+\b/g)[1];
        lastIp = ip;
        lastIpTimestamp = getTimestamp();
        if (ip.startsWith('192')) {
          lastRunState = runState.FOUND_INTERNAL;
          log(`Internal IP detected [${ip}]`, 'WARN');
          restartRouter();
        } else {
          lastRunState = runState.FOUND_EXTERNAL;
          (restartAttempts > 0) ? 
            log(`Restored to external IP [${ip}]`) : 
            log(`Found external IP [${ip}] - No operation`, 'DEBUG');
          restartAttempts = 0;
          skipUntil = 0;
        }
        setTimeout(checkExternalIP, checkInterval);
      }
    });
  } else {
    lastRunState = runState.SKIPPED;
    setTimeout(checkExternalIP, checkInterval);
  }
}

function restartRouter() {
  restartAttempts += 1;
  if (restartAttempts > allowedRestartAttempts) {
    log('Too many consecutive restarts - Shutting down', 'WARN');
    updateStatus(statuses.STOPPED);
  }
  log('Restarting router', 'WARN');
  updateStatus(statuses.REBOOTING);
  lastReboot = getTimestamp();
  const rebootCmd = `id=$(wget -q -O- --http-user ${process.env.NETGEAR_USER} --http-password ${process.env.NETGEAR_PASS} http://${process.env.NETGEAR_IP}/ADVANCED_home2.htm | perl -lne '/id=([a-f0-9]+)/ && print $1'); wget -O- --http-user ${process.env.NETGEAR_USER} --http-password ${process.env.NETGEAR_PASS} http://${process.env.NETGEAR_IP}/newgui_adv_home.cgi?id=$id --post-data "id=$id&buttonType=2";`;
  execAsync(rebootCmd);
  setTimeout(() => updateStatus(statuses.RUNNING), 150000); // Allow 2.5 minutes for router reboot
}

function updateStatus(newStatus) {
  status = newStatus;
  statusUpdateTime = getTimestamp();
}

function log(message, level='INFO') {
  if (!ignoredLogLevels.includes(level.toUpperCase())) {
    level = '[' + level.substring(0, 6) + ']';
    fs.appendFileSync('netgear-rebooter.log', `${getTimestamp()} ${level.padEnd(8, ' ')} ${message}\n`, (err) => {});
  }
}

function getTimestamp() {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  var hours = date.getHours() % 12;
  hours = String(hours ? hours : 12).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} ${date.getHours() >= 12 ? 'PM' : 'AM'}`;
}

process.on('SIGTERM', () => {
  log('SIGTERM - Shutting down');
  console.log('SIGTERM - Shutting down');
  process.exit();
});
process.on('SIGINT', () => {
  log('SIGINT - Shutting down');
  console.log('SIGINT - Shutting down');
  process.exit();
});

log(`Service starting`);
updateStatus(statuses.RUNNING);
checkExternalIP();
