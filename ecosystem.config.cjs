// PM2 ecosystem file for IL Job Scanner
// Runs tsx directly (skipping npm wrapper) — works on Windows + Linux + macOS

module.exports = {
  apps: [
    {
      name: "il-job-scanner",
      script: "node_modules/tsx/dist/cli.mjs",
      args: "src/server.ts",
      cwd: __dirname,
      interpreter: "node",
      exec_mode: "fork",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
