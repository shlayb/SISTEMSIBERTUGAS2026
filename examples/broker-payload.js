// Adapt this mapping to your MQTT broker's HTTP action/template.
// deviceId must come from the broker's trusted topic/client mapping, not an arbitrary publisher.
export function toLogPayload(telemetry, deviceId) {
  const data = typeof telemetry === 'string' ? JSON.parse(telemetry) : telemetry;
  return {
    eventId: data.id, deviceId, ts: data.ts,
    temperature: data.temperature, humidity: data.humidity, smoke: data.smoke,
    setpoint: data.setpoint,
    status: data.smoke >= data.smokeThreshold ? 'CRITICAL' : data.temperature > data.setpoint ? 'WARNING' : 'NORMAL',
    actuators: data.actuators && { servo: data.actuators.servo, buzzer: data.actuators.buzzer, led: data.actuators.led },
    eventType: data.replay === true ? 'BUFFER_SYNC' : 'TELEMETRY',
    source: 'device', replay: data.replay === true
  };
}
