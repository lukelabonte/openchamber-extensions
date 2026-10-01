import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

const servicePort = Number(process.env.OPENCHAMBER_SERVICE_PORT)
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN

if (!Number.isInteger(servicePort) || servicePort < 0) {
  throw new Error("OPENCHAMBER_SERVICE_PORT must be set to a valid port")
}
if (!serviceToken) {
  throw new Error("OPENCHAMBER_SERVICE_TOKEN must be set")
}

function isAuthorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${serviceToken}`
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  if (!isAuthorized(request)) {
    response.statusCode = 401
    response.end()
    return
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (request.method === "GET" && pathname === "/health") {
    response.statusCode = 200
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ status: "ok" }))
    return
  }
  response.statusCode = 404
  response.end()
}

createServer(handleRequest).listen(servicePort, "127.0.0.1")
