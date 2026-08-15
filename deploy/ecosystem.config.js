// PM2 process definition for the upload server.
//   pm2 start deploy/ecosystem.config.js
//   pm2 save && pm2 startup   (to survive reboots)
//
// Secrets come from server/.env (see server/.env.example), not from here.
module.exports = {
  apps: [
    {
      name: 'eibapks-upload',
      cwd: './server',
      script: 'server.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '256M',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
