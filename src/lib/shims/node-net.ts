/**
 * Browser stub for Node-only modules pulled in by gramjs (socks / net / tls).
 * gramjs only uses these in Node; in the browser it talks over WebSockets.
 */
class Noop {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(..._args: any[]) {}
  on() { return this; }
  once() { return this; }
  off() { return this; }
  removeListener() { return this; }
  emit() { return false; }
  connect() { return this; }
  end() { return this; }
  destroy() { return this; }
  write() { return false; }
  setKeepAlive() { return this; }
}

export const SocksClient = Noop;
export const SocksClientError = Error;
export const Socket = Noop;
export const Server = Noop;
export const createConnection = () => new Noop();
export const connect = () => new Noop();

export default { SocksClient, SocksClientError, Socket, Server, createConnection, connect };
