import { createAdapter } from '@socket.io/redis-adapter';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { io as connect } from 'socket.io-client';

/**
 * Two Socket.IO servers sharing rooms through Redis, as two delivery-service
 * replicas do:  REDIS_TEST_URL=redis://localhost:6399 npx jest --testRegex int-spec
 */
const url = process.env.REDIS_TEST_URL;
const describeIfRedis = url ? describe : describe.skip;

async function replica() {
  const pub = createClient({ url });
  const sub = pub.duplicate();
  await Promise.all([pub.connect(), sub.connect()]);
  const http = createServer();
  const server = new Server(http, { transports: ['websocket'], adapter: createAdapter(pub, sub) });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const close = async () => {
    server.close();
    await Promise.all([pub.quit(), sub.quit()]);
  };
  return { server, port: (http.address() as AddressInfo).port, close };
}

describeIfRedis('Redis Socket.IO adapter', () => {
  it('delivers an event emitted on one replica to a client of the other', async () => {
    const a = await replica();
    const b = await replica();
    a.server.on('connection', (socket) => void socket.join('couriers'));

    const client = connect(`http://localhost:${a.port}`, { transports: ['websocket'] });
    await new Promise<void>((resolve) => client.on('connect', () => resolve()));
    await new Promise((r) => setTimeout(r, 200)); // room join propagated

    const received = new Promise((resolve) => client.on('delivery:available', resolve));
    b.server.to('couriers').emit('delivery:available', { id: 'd1' });

    await expect(received).resolves.toEqual({ id: 'd1' });
    client.close();
    await Promise.all([a.close(), b.close()]);
  });
});
