import mqtt, { type MqttClient } from 'mqtt';
import { describe, expect, it } from 'vitest';
import { type Broker, watchBroker } from './mosquitto.ts';
import { onCleanup, useFakeClock } from './support.ts';

/** A client publishing under the broker's prefix, as the bridge does; ended after the test. */
function connectUnder(broker: Broker) {
  return new Promise<MqttClient>((resolve) => {
    const client = mqtt.connect(`mqtt://${broker.hostname}:${broker.port}`, { keepalive: 0, reconnectPeriod: 0 });
    onCleanup(() => new Promise<void>((done) => { client.end(true, () => done()); }));
    client.once('connect', () => resolve(client));
  });
}

const publish = (client: MqttClient, topic: string, payload: string) => new Promise<void>((resolve) => {
  client.publish(topic, payload, { qos: 1, retain: true }, () => resolve());
});

describe('watchBroker()', () => {
  it('reports what other clients publish under its prefix, without the prefix and without the command topics', async () => {
    const broker = await watchBroker();
    const client = await connectUnder(broker);

    await publish(client, `${broker.prefix}paradox/status/armed`, 'ON');
    await publish(client, `${broker.prefix}paradox/command/arm`, 'x');
    await broker.publish('paradox/sensor/0', 'OFF');
    await broker.barrier();

    expect(broker.published).toEqual([
      { topic: 'paradox/status/armed', payload: 'ON' },
      { topic: 'paradox/sensor/0', payload: 'OFF' },
    ]);
  });

  it('sees nothing published under another prefix', async () => {
    const [mine, other] = await Promise.all([watchBroker(), watchBroker()]);

    await other.publish('paradox/status/armed', 'ON', { retain: true });
    await mine.barrier();

    expect(mine.published).toEqual([]);
    expect(await mine.retained('paradox/status/armed')).toBeNull();
    expect(await other.retained('paradox/status/armed')).toBe('ON');
  });

  it('works while the fake clock is installed', async () => {
    const broker = await watchBroker();
    const clock = useFakeClock();
    const client = await connectUnder(broker);

    await publish(client, `${broker.prefix}paradox/status/armed`, 'ON');
    await clock.advance(5000);
    await broker.barrier();

    expect(broker.published).toEqual([{ topic: 'paradox/status/armed', payload: 'ON' }]);
    expect(await broker.retained('paradox/status/armed')).toBe('ON');
  });
});
