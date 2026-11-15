import dns from "node:dns";
dns.setDefaultResultOrder("ipv4first");
import { Readable } from "node:stream";
import { EdgeTTS } from "node-edge-tts";

export const MALE_VOICE = "en-US-ChristopherNeural";

export interface WeatherLocation {
  name: string;
  country: string;
  lat: number;
  lon: number;
}

export interface PlaybackItem {
  title: string;
  url?: string;
  getStream?: () => Promise<Readable>;
}

export interface WeatherResult {
  title: string;
  displayText: string;
  items: PlaybackItem[];
}

export type WeatherResponse =
  | { success: true; result: WeatherResult }
  | { success: false; error: string };

export const DEFAULT_LOCATIONS: WeatherLocation[] = [
  { name: "Dhaka", country: "Bangladesh", lat: 23.7104, lon: 90.40744 },
  { name: "Rangpur", country: "Bangladesh", lat: 25.74664, lon: 89.25166 },
];

export function getWeatherDescription(code: number): string {
  switch (code) {
    case 0: return "Clear sky";
    case 1: return "Mainly clear";
    case 2: return "Partly cloudy";
    case 3: return "Overcast";
    case 45: case 48: return "Foggy";
    case 51: case 53: case 55: return "Drizzle";
    case 61: return "Light rain";
    case 63: return "Moderate rain";
    case 65: return "Heavy rain";
    case 71: case 73: case 75: return "Snow";
    case 80: case 81: case 82: return "Rain showers";
    case 95: return "Thunderstorm";
    case 96: case 99: return "Thunderstorm with hail";
    default: return "Partly cloudy";
  }
}

export function getWeatherEmoji(code: number): string {
  switch (code) {
    case 0: return "☀️";
    case 1: case 2: return "🌤️";
    case 3: return "☁️";
    case 45: case 48: return "🌫️";
    case 51: case 53: case 55: return "🌦️";
    case 61: case 63: case 65: return "🌧️";
    case 71: case 73: case 75: return "❄️";
    case 80: case 81: case 82: return "🌧️";
    case 95: case 96: case 99: return "⛈️";
    default: return "⛅";
  }
}

export async function geocodeLocation(query: string): Promise<WeatherLocation | null> {
  const trimmed = query.trim().toLowerCase();
  for (const def of DEFAULT_LOCATIONS) {
    if (trimmed === def.name.toLowerCase()) {
      return def;
    }
  }

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=1`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;
    const r = data.results[0];
    return {
      name: r.name,
      country: r.country || "",
      lat: r.latitude,
      lon: r.longitude,
    };
  } catch {
    return null;
  }
}

export async function fetchForecast(lat: number, lon: number): Promise<any> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    throw new Error(`Weather service error: ${res.status}`);
  }
  return res.json();
}

export async function createTtsStream(text: string, voice = MALE_VOICE): Promise<Readable> {
  const tts = new EdgeTTS({
    voice,
    lang: "en-US",
    outputFormat: "audio-24khz-96kbitrate-mono-mp3",
  });

  async function* generate() {
    for await (const chunk of tts.streamAudio(text)) {
      if (Buffer.isBuffer(chunk)) {
        yield chunk;
      }
    }
  }

  return Readable.from(generate());
}

function buildTodayReport(loc: WeatherLocation, data: any): { speech: string; display: string } {
  const currentTemp = Math.round(data.current.temperature_2m);
  const condition = getWeatherDescription(data.current.weather_code);
  const humidity = data.current.relative_humidity_2m;
  const wind = Math.round(data.current.wind_speed_10m);
  const maxTemp = Math.round(data.daily.temperature_2m_max[0]);
  const minTemp = Math.round(data.daily.temperature_2m_min[0]);
  const rain = data.daily.precipitation_sum[0];
  const icon = getWeatherEmoji(data.current.weather_code);

  const countryPart = loc.country ? `, ${loc.country}` : "";
  let speech = `Today's weather for ${loc.name}${countryPart}: Currently ${currentTemp} degrees Celsius with ${condition.toLowerCase()}. `;
  speech += `Humidity is ${humidity} percent with winds at ${wind} kilometers per hour. `;
  speech += `Today's high is ${maxTemp} degrees and the low is ${minTemp} degrees. `;
  if (rain > 0) {
    speech += `Expected precipitation is ${rain} millimeters.`;
  }

  const display =
    `### ${icon} ${loc.name}${countryPart} — Today\n` +
    `- **Current:** ${currentTemp}°C (${condition})\n` +
    `- **High / Low:** ${maxTemp}°C / ${minTemp}°C\n` +
    `- **Humidity:** ${humidity}% | **Wind:** ${wind} km/h` +
    (rain > 0 ? ` | **Precipitation:** ${rain} mm` : "");

  return { speech: speech.trim(), display };
}

function buildWeekReport(loc: WeatherLocation, data: any): { speech: string; display: string } {
  const countryPart = loc.country ? `, ${loc.country}` : "";
  let speech = `7-day weather forecast for ${loc.name}${countryPart}. `;
  let display = `### 📅 7-Day Forecast: ${loc.name}${countryPart}\n`;

  const times: string[] = data.daily.time;
  const daysCount = Math.min(times.length, 7);

  for (let i = 0; i < daysCount; i++) {
    const dayDate = new Date(times[i] + "T12:00:00Z");
    const dayFull = dayDate.toLocaleDateString("en-US", { weekday: "long" });
    const dayShort = dayDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const code = data.daily.weather_code[i];
    const condition = getWeatherDescription(code);
    const icon = getWeatherEmoji(code);
    const max = Math.round(data.daily.temperature_2m_max[i]);
    const min = Math.round(data.daily.temperature_2m_min[i]);
    const rain = data.daily.precipitation_sum[i];

    speech += `${dayFull}: ${condition}, high of ${max}, low of ${min} degrees. `;
    display += `• **${dayShort}**: ${icon} ${max}°C / ${min}°C — ${condition}${rain > 0 ? ` (${rain}mm)` : ""}\n`;
  }

  return { speech: speech.trim(), display: display.trim() };
}

export async function getWeatherForecast(
  type: "today" | "week",
  locationQuery?: string
): Promise<WeatherResponse> {
  try {
    if (locationQuery && locationQuery.trim().length > 0) {
      const loc = await geocodeLocation(locationQuery);
      if (!loc) {
        return {
          success: false,
          error: `Could not find location "${locationQuery.trim()}". Please enter a valid city name or postal/zip code.`,
        };
      }

      const data = await fetchForecast(loc.lat, loc.lon);
      const report = type === "today" ? buildTodayReport(loc, data) : buildWeekReport(loc, data);
      const title = type === "today" ? `Weather Today: ${loc.name}` : `7-Day Weather: ${loc.name}`;

      return {
        success: true,
        result: {
          title,
          displayText: report.display,
          items: [
            {
              title,
              getStream: () => createTtsStream(report.speech),
            },
          ],
        },
      };
    }

    // Default case: Dhaka and Rangpur
    const [dhakaData, rangpurData] = await Promise.all([
      fetchForecast(DEFAULT_LOCATIONS[0].lat, DEFAULT_LOCATIONS[0].lon),
      fetchForecast(DEFAULT_LOCATIONS[1].lat, DEFAULT_LOCATIONS[1].lon),
    ]);

    const dhakaReport = type === "today"
      ? buildTodayReport(DEFAULT_LOCATIONS[0], dhakaData)
      : buildWeekReport(DEFAULT_LOCATIONS[0], dhakaData);

    const rangpurReport = type === "today"
      ? buildTodayReport(DEFAULT_LOCATIONS[1], rangpurData)
      : buildWeekReport(DEFAULT_LOCATIONS[1], rangpurData);

    const combinedDisplay = `${dhakaReport.display}\n\n${rangpurReport.display}`;
    const title = type === "today" ? "Weather Today: Dhaka & Rangpur" : "7-Day Weather: Dhaka & Rangpur";

    return {
      success: true,
      result: {
        title,
        displayText: combinedDisplay,
        items: [
          {
            title: `${title} (Dhaka)`,
            getStream: () => createTtsStream(dhakaReport.speech),
          },
          {
            title: `${title} (Rangpur)`,
            getStream: () => createTtsStream(`And now, ${rangpurReport.speech}`),
          },
        ],
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: `Failed to retrieve weather data: ${err.message}`,
    };
  }
}
