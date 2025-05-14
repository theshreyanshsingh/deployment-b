const { exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const Redis = require("ioredis");
const { execSync } = require("child_process");

const PROJECT_NAME = process.env.PROJECT_ID;
const PROJECT_ID = PROJECT_NAME;
const CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// Connection timeout to ensure Redis doesn't keep process alive indefinitely
const publisher = new Redis({
  port: 6379,
  host: "3.109.186.255",
  connectTimeout: 10000, // 10 seconds
  maxRetriesPerRequest: 3,
});

// Handle Redis connection errors
publisher.on("error", (err) => {
  console.error(`Redis error: ${err.message}`);
  cleanup(`Redis connection failed: ${err.message}`, 1);
});

function publishLog(log) {
  try {
    publisher.publish(`logs:${PROJECT_ID}`, JSON.stringify({ log }));
  } catch (err) {
    console.error(`Failed to publish log: ${err.message}`);
  }
}

// Centralized cleanup function to ensure proper shutdown
function cleanup(message, exitCode = 0) {
  console.log(message);
  if (publisher) {
    publisher.disconnect();
  }

  // Force exit after a timeout if something is still keeping the process alive
  setTimeout(() => {
    console.log("Forcing process exit after timeout");
    process.exit(exitCode);
  }, 3000);
}

async function init() {
  console.log("Executing script.js -New changed ");
  publishLog("New Build Started...");

  try {
    const outDirPath = path.join(__dirname, "output");

    // Check if output directory exists
    if (!fs.existsSync(outDirPath)) {
      throw new Error(`Output directory not found at: ${outDirPath}`);
    }

    // Create a promise to handle the build process
    const buildProcess = new Promise((resolve, reject) => {
      const p = exec(
        `cd ${outDirPath} && npm install && npm i wrangler -g && npm install --save-dev @cloudflare/next-on-pages && npx next-on-pages`
      );

      p.stdout.on("data", function (data) {
        console.log(data.toString());
        publishLog(data.toString());
      });

      p.stderr.on("data", function (data) {
        console.error(data.toString());
        publishLog(`error: ${data.toString()}`);
      });

      p.on("error", function (err) {
        console.error(`Process error: ${err.message}`);
        publishLog(`error: Process error: ${err.message}`);
        reject(err);
      });

      p.on("close", function (code) {
        console.log(`Build process exited with code ${code}`);
        if (code === 0) {
          console.log("Build Complete");
          publishLog(`Build Complete`);
          resolve();
        } else {
          console.error(`Build failed with exit code ${code}`);
          publishLog(`Build failed with exit code ${code}`);
          reject(new Error(`Build failed with exit code ${code}`));
        }
      });
    });

    // Wait for build process to complete
    await buildProcess;

    publishLog(`Preparing Cloudflare Pages Deployment`);

    // Set Cloudflare Pages project configuration
    const cloudflareConfig = `
# Project name for Cloudflare Pages
name = "${PROJECT_ID}"
pages_build_output_dir = "${outDirPath}/.vercel/output/static"

# Required compatibility settings
compatibility_date = "2023-09-04"
compatibility_flags = ["nodejs_compat"]
`;

    try {
      const outputDirContents = fs.readdirSync(outDirPath, { recursive: true });
      publishLog(
        `Files in output directory: ${JSON.stringify(
          outputDirContents,
          null,
          2
        )}`
      );
    } catch (err) {
      publishLog(`Warning: Could not read output directory: ${err.message}`);
    }

    // Write out the Cloudflare Pages config
    fs.writeFileSync(path.join(outDirPath, "wrangler.toml"), cloudflareConfig);

    publishLog(`Cloudflare Pages Deployment Config Generated`);
    console.log("Preparing for Cloudflare Pages upload...");

    // Authenticate using the Cloudflare API token
    if (!CLOUDFLARE_API_TOKEN) {
      throw new Error("CLOUDFLARE_API_TOKEN environment variable is not set");
    }

    // Execute Cloudflare deployments synchronously to ensure completion
    try {
      console.log("Logging in to Cloudflare...");
      execSync(
        `cd ${outDirPath} && export CLOUDFLARE_API_TOKEN=${CLOUDFLARE_API_TOKEN} && wrangler login`,
        { stdio: "inherit" }
      );

      // Attempt to create the project, if it fails, continue to deploy
      try {
        console.log(`Creating Cloudflare Pages project: ${PROJECT_NAME}`);
        execSync(
          `cd ${outDirPath} && wrangler pages project create ${PROJECT_NAME} --production-branch=main`,
          { stdio: "inherit" }
        );
        console.log(`Project '${PROJECT_NAME}' created successfully.`);
        publishLog(`Project '${PROJECT_NAME}' created successfully.`);
      } catch (createError) {
        console.log(
          `Project creation failed (likely already exists): ${createError.message}`
        );
        publishLog(`Project creation failed: ${createError.message}`);
      }

      // Proceed with deployment
      console.log("Starting Cloudflare Pages deployment...");
      publishLog(`Deployment Started for ${PROJECT_NAME}`);

      execSync(
        `cd ${outDirPath} && wrangler pages deploy --commit-dirty=true`,
        { stdio: "inherit" }
      );

      console.log("Cloudflare Pages deployment completed successfully");
      publishLog(`Deployment completed successfully`);

      // Ensure all Redis messages are sent before disconnecting
      await new Promise((resolve) => setTimeout(resolve, 1000));

      console.log("All operations completed successfully.");
      process.exit(0);
    } catch (deployError) {
      console.error(`Deployment failed: ${deployError.message}`);
      publishLog(`Deployment failed: ${deployError.message}`);
      publisher.disconnect();
      process.exit(1);
    }
  } catch (error) {
    console.error(`Initialization error: ${error.message}`);
    publishLog(`Initialization error: ${error.message}`);
    publisher.disconnect();
    process.exit(1);
  }
}

// Handle process signals
process.on("SIGINT", () => cleanup("Process interrupted", 130));
process.on("SIGTERM", () => cleanup("Process terminated", 143));
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  cleanup(`Uncaught exception: ${err.message}`, 1);
});

init();
