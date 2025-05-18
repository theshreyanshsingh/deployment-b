const express = require("express");
const { generateSlug } = require("random-word-slugs");
const { ECSClient, RunTaskCommand } = require("@aws-sdk/client-ecs");
const { Server } = require("socket.io");
const Redis = require("ioredis");
const cors = require("cors");
const morgan = require("morgan");
require("dotenv").config();
const serverless = require("serverless-http");

const app = express();
const PORT = 9000;

const subscriber = new Redis({
  port: 6379, // Redis port
  host: process.env.REDIS, // Redis host
});

const io = new Server({ cors: "*" });

io.on("connection", (socket) => {
  socket.on("subscribe", (channel) => {
    socket.join(channel);
    socket.emit("message", `Joined ${channel}`);
  });
});

io.listen(9002, () => console.log("Socket Server 9002"));

const ecsClient = new ECSClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_ID,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  },
});

const config = {
  CLUSTER: process.env.AWS_CLUSTER_ID,
  TASK: process.env.TASK_ID,
};

app.use(express.json());
app.use(cors());
app.use(morgan("dev"));

app.post("/api/project", async (req, res) => {
  const { repo, category, owner, accessToken, slug, env } = req.body;
  const projectSlug = slug ? slug : generateSlug();

  let gitURL = `https://x-access-token:${accessToken}@github.com/${owner}/${repo}.git`;
  //   let gitURL = `https://${accessToken}@github.com/${email}/${repo}.git`;

  let CREDENTIALS = {
    accessKeyId: process.env.AWS_ACCESS_ID,
    secretAccessKey: process.env.AWS_SECRET_KEY,
  };

  // Spin the container
  const command = new RunTaskCommand({
    cluster: config.CLUSTER,
    taskDefinition: config.TASK,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        assignPublicIp: "ENABLED",
        subnets: [
          "subnet-0de271f2058c977fc",
          "subnet-0fef14cae2cb0b36a",
          "subnet-04be4b2634af1e30f",
        ],
        securityGroups: ["sg-0c491d540828906ed"],
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: "builder-image",
          environment: [
            { name: "GIT_REPOSITORY__URL", value: gitURL },
            { name: "PROJECT_ID", value: repo },
            {
              name: "CLOUDFLARE_API_TOKEN",
              value: process.env.CLOUDFLARE_API_TOKEN,
            },
            {
              name: "TASK",
              value: category,
            },
            {
              name: "BUCKET",
              value: process.env.AWS_BUCKET,
            },
            {
              name: "LAMBDA_ROLE_ARN",
              value: process.env.LAMBDA_ROLE_ARN,
            },
            {
              name: "ENVVARS",
              value: env,
            },
            {
              name: "AWS_REGION",
              value: process.env.AWS_REGION,
            },
            {
              name: "CREDENTIALS",
              value: CREDENTIALS,
            },
          ],
        },
      ],
    },
  });

  await ecsClient.send(command);

  return res.json({
    status: "queued",
  });
});

app.post("/api/webhook", (req, res) => {
  console.log(res, req.body, "45676ty893900439039200908");
});

async function initRedisSubscribe() {
  console.log("Subscribed to logs....");
  subscriber.psubscribe("logs:*");
  subscriber.on("pmessage", (pattern, channel, message) => {
    io.to(channel).emit("message", message);
  });
}

initRedisSubscribe();

// app.listen(PORT, () => console.log(`API Server Running..${PORT}`));
module.exports.handler = serverless(app);
