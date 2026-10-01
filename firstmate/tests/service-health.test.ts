import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import net from "node:net"
import path from "node:path"

const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  servicePort = await getFreePort()
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
  await waitUntilListening()
})

afterAll(() => {
  serviceProcess?.kill()
})

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address !== null && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
        return
      }
      server.close()
      reject(new Error("could not determine a free port"))
    })
    server.on("error", reject)
  })
}

async function waitUntilListening(): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(healthUrl())
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("service did not start listening within 5 seconds")
}

function healthUrl(): string {
  return `http://127.0.0.1:${servicePort}/health`
}

describe("service", () => {
  test("binds loopback and answers GET /health with 200 for an authorized request", async () => {
    const response = await fetch(healthUrl(), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
  })

  test("rejects requests without a bearer token", async () => {
    const response = await fetch(healthUrl())
    expect(response.status).toBe(401)
  })

  test("rejects requests with a wrong bearer token", async () => {
    const response = await fetch(healthUrl(), {
      headers: { authorization: "Bearer wrong-token" },
    })
    expect(response.status).toBe(401)
  })
})
