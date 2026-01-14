module.exports = {
  apps: [
    {
      name: "TaintedBySatoshi_backend",
      cwd: "./backend",
      script: "./src/index.js",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "8G",
      env: {
        NODE_ENV: "production",
      },
      env_file: "./backend/.env",
      error_file: "./backend/logs/err.log",
      out_file: "./backend/logs/out.log",
      log_file: "./backend/logs/combined.log",
      time: true,
      // Prevent PM2 from killing the process during startup
      wait_ready: false,
      listen_timeout: 30000,  // 30 seconds to start listening
      kill_timeout: 10000,    // 10 seconds to gracefully shutdown
      // Exponential backoff restart delay
      exp_backoff_restart_delay: 1000,  // Start with 1 second delay
      max_restarts: 5,        // Limit restarts to 5 per minute
      min_uptime: "30s",      // Must stay up 30 seconds to be considered started
    },
    {
      name: "TaintedBySatoshi_frontend",
      cwd: "./frontend",
      script: "node_modules/next/dist/bin/next",
      args: "start",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "2G",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      env_file: "./frontend/.env",
      error_file: "./frontend/logs/err.log",
      out_file: "./frontend/logs/out.log",
      log_file: "./frontend/logs/combined.log",
      time: true,
      wait_ready: false,
      listen_timeout: 10000,
      kill_timeout: 5000,
      exp_backoff_restart_delay: 100,
      max_restarts: 10,
      min_uptime: "10s",
    },
  ],
};
