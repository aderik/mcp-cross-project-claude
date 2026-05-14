// Tiny TCP tee proxy: listens on `listenPort`, forwards to `targetHost:targetPort`,
// writes raw byte streams of each direction to files for inspection.
import { createServer, createConnection } from "node:net";
import { createWriteStream } from "node:fs";

const [, , listenPortArg, targetHost, targetPortArg, outPrefix] = process.argv;
const listenPort = Number(listenPortArg);
const targetPort = Number(targetPortArg);

let connCounter = 0;
const server = createServer((clientSock) => {
  const id = ++connCounter;
  const upstream = createConnection({ host: targetHost, port: targetPort });
  const upLog = createWriteStream(`${outPrefix}-${id}-c2s.bin`);
  const downLog = createWriteStream(`${outPrefix}-${id}-s2c.bin`);
  clientSock.on("data", (chunk) => {
    upLog.write(chunk);
    upstream.write(chunk);
  });
  upstream.on("data", (chunk) => {
    downLog.write(chunk);
    clientSock.write(chunk);
  });
  clientSock.on("end", () => upstream.end());
  upstream.on("end", () => clientSock.end());
  clientSock.on("error", () => {});
  upstream.on("error", () => {});
  clientSock.on("close", () => {
    upLog.end();
    downLog.end();
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  console.error(`tee-proxy listening on 127.0.0.1:${listenPort} -> ${targetHost}:${targetPort}`);
});
