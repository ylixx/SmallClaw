import { ToolResult } from '../types.js';

// Returns current date/time from the system clock — no network needed
export async function executeTimeNow(_args: {}): Promise<ToolResult> {
  const now = new Date();
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const dayName = days[now.getDay()];
  const monthName = months[now.getMonth()];
  const date = now.getDate();
  const year = now.getFullYear();
  const hours = now.getHours().toString().padStart(2, '0');
  const minutes = now.getMinutes().toString().padStart(2, '0');

  const result = `${dayName}, ${monthName} ${date}, ${year} — ${hours}:${minutes} local time`;
  return {
    success: true,
    stdout: result,
    data: {
      iso: now.toISOString(),
      day: dayName,
      date: `${year}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
      time: `${hours}:${minutes}`,
    },
  };
}

export const timeNowTool = {
  name: 'time_now',
  description: 'Get the current date, day of week, and local time from the system clock. Use this for ANY question about what day/date/time it is — never use web_search for this.',
  execute: executeTimeNow,
  schema: {},
};
