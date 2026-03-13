const path = require('path');
const { Service } = require('node-windows');

const svc = new Service({
  name: 'Comrade Claw',
  script: path.join(__dirname, 'src', 'index.js')
});

svc.on('uninstall', () => {
  console.log('Comrade Claw service uninstalled.');
});

svc.on('invalidinstallation', () => {
  console.log('Service is not installed.');
});

console.log('Uninstalling Comrade Claw service...');
svc.uninstall();
