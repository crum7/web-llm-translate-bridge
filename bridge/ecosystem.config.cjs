// pm2 ecosystem file for llm-translate-bridge.
// Usage from the `bridge/` folder:
//   pm2 start ecosystem.config.cjs
//   pm2 logs llm-translate-bridge
//   pm2 restart llm-translate-bridge
//   pm2 stop llm-translate-bridge
//   pm2 save                     # persist across reboot (with pm2-startup)
//   pm2 startup                  # print the OS-specific command to enable boot start

module.exports = {
  apps: [
    {
      name: "llm-translate-bridge",
      script: "index.js",
      cwd: __dirname,
      // Restart automatically if the process crashes.
      autorestart: true,
      // Don't loop forever if it fails immediately — give up after 10 restarts in 60s.
      max_restarts: 10,
      min_uptime: "60s",
      restart_delay: 2000,
      // Send logs to per-process files under the bridge/ dir (gitignored via ../.gitignore *.log).
      out_file: "./pm2.out.log",
      error_file: "./pm2.err.log",
      merge_logs: true,
      time: true, // prefix log lines with timestamp
      env: {
        NODE_ENV: "production",
        // Everything else (MODE, PORT, MODEL, BRIDGE_TOKEN, etc.) is inherited
        // from the shell that runs `pm2 start`. Set them there if you want to
        // override, e.g.:
        //   $env:MODEL="opus"; pm2 restart llm-translate-bridge --update-env
      },
    },
  ],
};
