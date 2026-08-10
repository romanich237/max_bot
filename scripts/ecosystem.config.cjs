const path = require('path');

const root = path.join(__dirname, '..');

module.exports = {
  apps: [
    {
      name: 'max-tg',
      script: 'scripts/monitor.js',
      cwd: root,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '600M',
      restart_delay: 5000,
      exp_backoff_restart_delay: 200,
      max_restarts: 100,
      min_uptime: '15s',
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/err.log',
      out_file: './logs/out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'max-tg-update',
      script: 'scripts/auto-update.js',
      cwd: root,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '120M',
      restart_delay: 10000,
      env: {
        NODE_ENV: 'production',
      },
      error_file: './logs/update-err.log',
      out_file: './logs/update-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
