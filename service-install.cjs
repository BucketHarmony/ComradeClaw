const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Comrade Claw',
  description: 'Autonomous AI agent for FALGSC solidarity posting',
  script: path.join(__dirname, 'src', 'index.js'),
  nodeOptions: ['--tls-cipher-list=DEFAULT'],
  workingDirectory: __dirname,
  wait: 2,
  grow: 0.5,
  maxRestarts: 5
});

svc.on('install', () => {
  console.log('Service installed. Starting...');
  svc.start();
});

svc.on('alreadyinstalled', () => {
  console.log('Service is already installed.');
});

svc.on('start', () => {
  console.log('Comrade Claw service started.');
});

svc.on('error', (err) => {
  console.error('Service error:', err);
});

console.log('Installing Comrade Claw as Windows service...');
console.log('Script:', path.join(__dirname, 'src', 'index.js'));
console.log('Working directory:', __dirname);
svc.install();
