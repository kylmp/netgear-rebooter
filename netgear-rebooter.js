require('dotenv').config();
const fs = require('fs');
const request = require('request');
const execSync = require('child_process').execSync;
const execAsync = require('child_process').exec;
const express = require('express');

const server = express();
const port = parseInt(process.env.PORT || 3000);
const lightTheme = (process.env.THEME || 'light') === 'light';
const checkInterval = parseInt(process.env.RUN_INTERVAL);
const allowedLoginAttemps = parseInt(process.env.ALLOWED_LOGIN_ATTEMPTS);
const allowedRestartAttempts = parseInt(process.env.ALLOWED_RESTART_ATTEMPTS);
const ignoredLogLevels = (process.env.IGNORED_LOG_LEVELS || '').toUpperCase().split(',');
const baseUrl = process.env.BASE_URL || '';
const uiFavicon = process.env.UI_FAVICON_FILE;
const serverUrl = (process.env.SERVER_URL || `http://${process.env.SERVER_LOCAL_IP}:${port}`) + baseUrl;
const logFile = `${process.env.LOG_DIR || ''}netgear-rebooter.log`;
const start = getTimestamp();

const statuses = {RUNNING: 'RUNNING', STOPPED: 'STOPPED', REBOOTING: 'REBOOTING', PAUSED: 'PAUSED'};
const runState = {
  SKIPPED: {id: 'skip', val: 'Skipped due to non-running status'}, 
  UNAUTHENTICATED: {id: 'unauth', val: 'Unauthenticated (logging into router)'}, 
  FOUND_EXTERNAL: {id: 'extern', val: 'External IP found (no operation)'}, 
  FOUND_INTERNAL: {id: 'intern', val: 'Internal IP found (rebooting router)'}
};

let status;
let statusUpdateTime;
let lastIp;
let lastIpTimestamp;
let lastRunState = runState.SKIPPED;
let lastRunAttemptTimestamp;
let loginTimestamp = '-';
let rebootTimestamp = '-';
let pauseTimestamp;

let loginAttempts = 0;
let totalLoginAttempts = 0;
let totalLoginCount = 0;
let rebootAttempts = 0;
let totalRebootAttempts = 0;
let totalRebootCount = 0;
let statecounts = {};

const cssDark = `body { font-family: arial, sans-serif; color: #cccccc; background-color: #111111 }button {  background-color: #333333;  border: 1px solid transparent;  border-radius: .65rem;  box-sizing: border-box;  color: #FFFFFF;  cursor: pointer;  flex: 0 0 auto;  font-family: arial, sans-serif;  font-size: .9rem;  font-weight: 250;  line-height: 1rem;  padding: .5rem .8rem;  text-align: center;  text-decoration: none #6B7280 solid;  text-decoration-thickness: auto;  transition-duration: .2s;  transition-property: background-color,border-color,color,fill,stroke;  transition-timing-function: cubic-bezier(.4, 0, 0.2, 1);  user-select: none;  -webkit-user-select: none;  touch-action: manipulation;  width: auto;}button:hover {  background-color: #374151;}button:focus {  box-shadow: none;  outline: 2px solid transparent;  outline-offset: 2px;}@media (min-width: 768px) {  button {    padding: .5rem 1rem;  }}`;
const cssLight = `body { font-family: arial, sans-serif; }button {  background-color: #dddddd;  border: 1px solid transparent;  border-radius: .65rem;  box-sizing: border-box;  color: #222222;  cursor: pointer;  flex: 0 0 auto;  font-family: arial, sans-serif;  font-size: .9rem;  font-weight: 250;  line-height: 1rem;  padding: .5rem .8rem;  text-align: center;  text-decoration: none #6B7280 solid;  text-decoration-thickness: auto;  transition-duration: .2s;  transition-property: background-color,border-color,color,fill,stroke;  transition-timing-function: cubic-bezier(.4, 0, 0.2, 1);  user-select: none;  -webkit-user-select: none;  touch-action: manipulation;  width: auto;}button:hover {  background-color: #cccccc;}button:focus {  box-shadow: none;  outline: 2px solid transparent;  outline-offset: 2px;}@media (min-width: 768px) {  button {    padding: .5rem 1rem;  }}`;

server.get(`${baseUrl}/`, (req, res) => {
  const favicon = uiFavicon ? `<link rel="icon" type="image/png" href="${uiFavicon}"/>` : '';
  let statusInfo = status === statuses.PAUSED ? `(Until ${pauseTimestamp})` : `(Since ${statusUpdateTime})`;
  res.set('Content-Type', 'text/html');
  res.send(`
    <!DOCTYPE html><html><head>${favicon}<style>${lightTheme ? cssLight : cssDark}</style></head><body>
    Netgear Rebooter Status: <b>${status}</b> ${statusInfo}<br/><br/>
    Last IP found: <b>${lastIp}</b> [ ${lastIpTimestamp} ]<br/>
    Last run state: <b>${lastRunState.val}</b> [ ${lastRunAttemptTimestamp} ]<br/>Last router login: <b>${loginTimestamp}</b><br/>
    Last router reboot: <b>${rebootTimestamp}</b><br/><br/>
    Total run count: <b>${statecounts.total}</b> (external: ${statecounts[runState.FOUND_EXTERNAL.id]}, internal: ${statecounts[runState.FOUND_INTERNAL.id]}, unauthenticated: ${statecounts[runState.UNAUTHENTICATED.id]}, skipped: ${statecounts[runState.SKIPPED.id]})<br/>
    Total login count: <b>${totalLoginCount}</b> (${totalLoginAttempts} attempts)<br/>
    Total reboot count: <b>${totalRebootCount}</b> (${totalRebootAttempts} attempts)<br/><br/>
    Current restart attempts: ${rebootAttempts} (Limit: ${allowedRestartAttempts})<br/>
    Current login attempts: ${loginAttempts} (Limit: ${allowedLoginAttemps})<br/><br/>
    <button type="submit" onclick="location.href='${serverUrl}/restart'">Restart / Unpause</button><br/><br/>
    <button type="submit" onclick="location.href='${serverUrl}/'">Refresh Page</button><br/><br/>
    <button type="submit" onclick="location.href='${serverUrl}/pause'">10 Minute Pause</button><br/><br/>
    <button type="submit" onclick="location.href='${serverUrl}/stop'">Stop Checks</button><br/><br/>
    Server started at ${start}<br/>Page updated at ${getTimestamp()}
    </body></html>
  `);
});

server.get(`${baseUrl}/stop`, (req, res) => {
  updateStatus(statuses.STOPPED);
  res.redirect('/');
})

server.get(`${baseUrl}/pause`, (req, res) => {
  updateStatus(statuses.PAUSED);
  pauseTimestamp = getTimestamp(10);
  setTimeout(() => updateStatus(statuses.RUNNING), 600000); // Pause for 10 minutes
  res.redirect('/');
});

server.get(`${baseUrl}/restart`, (req, res) => {
  if (status === statuses.STOPPED || status === statuses.PAUSED) {
    updateStatus(statuses.RUNNING);
    rebootAttempts = 0;
    loginAttempts = 0;
    pauseTimestamp = '-';
    res.redirect('/');
  } else {
    const responseText = `Did not restart, status [${status}] does not allow restarting, try again later`;
    res.send(`${responseText}<br/><br/><button type="submit" onclick="location.href='${serverUrl}'">Home</button>`);
  }
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
        log('Unauthenticated - logging into router');
        updateState(runState.UNAUTHENTICATED);
        if (loginAttempts++ >= allowedLoginAttemps) {
          log('Too many failed login attempts - Shutting down', 'WARN');
          updateStatus(statuses.STOPPED);
        }
        totalLoginAttempts++;
        execSync(`wget -qO- ${endpoint} &> /dev/null`); // hack to get the netgear auth token (wget handles auth for server)
        setTimeout(checkExternalIP, 1000);
      } else {
        const match = body.match(/\b\d+\.\d+\.\d+\.\d+\b/g);
        if (!match) {
          setTimeout(checkExternalIP, checkInterval);
          return;
        }
        const ip = match[1];
        if (lastRunState === runState.UNAUTHENTICATED) {
          log('Login successful');
          loginTimestamp = getTimestamp();
          loginAttempts = 0;
          totalLoginCount++;
        }
        lastIp = ip;
        lastIpTimestamp = getTimestamp();
        if (ip.startsWith('192')) {
          log(`Internal IP detected [${ip}]`, 'WARN');
          updateState(runState.FOUND_INTERNAL);
          restartRouter();
        } else {
          if (rebootAttempts > 0) {
            log(`Restored to external IP [${ip}]`);
            totalRebootCount++;
          } else {
            log(`Found external IP [${ip}] - No operation`, 'DEBUG')
          }
          updateState(runState.FOUND_EXTERNAL);
          rebootAttempts = 0;
        }
        setTimeout(checkExternalIP, checkInterval);
      }
    });
  } else {
    updateState(runState.SKIPPED);
    setTimeout(checkExternalIP, checkInterval);
  }
}

function restartRouter() {
  totalRebootAttempts++;
  rebootAttempts++;
  if (rebootAttempts > allowedRestartAttempts) {
    log('Too many consecutive restarts - Shutting down', 'WARN');
    updateStatus(statuses.STOPPED);
  } else {
    log('Restarting router', 'WARN');
    updateStatus(statuses.REBOOTING);
    rebootTimestamp = getTimestamp();
    const rebootCmd = `id=$(wget -q -O- --http-user ${process.env.NETGEAR_USER} --http-password ${process.env.NETGEAR_PASS} http://${process.env.NETGEAR_IP}/ADVANCED_home2.htm | perl -lne '/id=([a-f0-9]+)/ && print $1'); wget -O- --http-user ${process.env.NETGEAR_USER} --http-password ${process.env.NETGEAR_PASS} http://${process.env.NETGEAR_IP}/newgui_adv_home.cgi?id=$id --post-data "id=$id&buttonType=2";`;
    execAsync(rebootCmd);
    setTimeout(() => updateStatus(statuses.RUNNING), 150000); // Allow 2.5 minutes for router reboot
  }
}

function updateState(newState) {
  lastRunState = newState;
  statecounts[newState.id]++;
  statecounts.total++;
}

function updateStatus(newStatus) {
  status = newStatus;
  statusUpdateTime = getTimestamp();
}

function log(message, level='INFO') {
  if (!ignoredLogLevels.includes(level.toUpperCase())) {
    level = '[' + level.substring(0, 6) + ']';
    fs.appendFileSync(logFile, `${getTimestamp()} ${level.padEnd(8, ' ')} ${message}\n`, (err) => {});
  }
}

function getTimestamp(offsetMinutes = 0) {
  let date = new Date();
  date.setMinutes(date.getMinutes() + offsetMinutes); 
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
Object.values(runState).forEach(state => statecounts[state.id] = 0);
statecounts.total = 0;
updateStatus(statuses.RUNNING);
checkExternalIP();
