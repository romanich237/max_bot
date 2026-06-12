module.exports = {
  apps: [
    {
      name: 'max-tg',
      script: 'index.js',
      cwd: __dirname,
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
  ],
};
