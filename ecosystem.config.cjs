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
        YHUNTER_DATA_DIR: "/var/lib/yhunter"
      }
    }
  ]
};
