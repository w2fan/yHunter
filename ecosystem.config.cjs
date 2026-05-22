module.exports = {
  apps: [
    {
      name: "yhunter",
      script: "npm",
      args: "start",
      cwd: "/opt/yHunter",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        YHUNTER_DATA_DIR: "/var/lib/yhunter",
        OPENSSL_CONF: "/opt/yHunter/openssl-legacy.cnf"
      }
    },
    {
      name: "yhunter-refresh-scheduler",
      script: "scripts/refresh-scheduler.mjs",
      cwd: "/opt/yHunter",
      autorestart: true,
      env: {
        NODE_ENV: "production",
        YHUNTER_BASE_URL: "http://127.0.0.1:3000",
        YHUNTER_REFRESH_AT: "09:20,16:20,22:20"
      }
    }
  ]
};
