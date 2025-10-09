import tls from "tls";
import { write, file } from "bun";
import { mkdir } from "fs/promises";


interface ProxyStruct {
  address: string;
  port: number;
  country: string;
  org: string;
}

interface ProxyTestResult {
  error: boolean;
  message?: string;
  result?: {
    proxy: string;
    proxyip: boolean;
    ip: string;
    port: number;
    delay: number;
    country: string;
    asOrganization: string;
  };
}

let myGeoIpString: string | null = null;

const SOURCE_FILE = "./SOURCE/proxy.txt";
const RESULT_DIR = "./RESULT";
const RESULT_ALL = `${RESULT_DIR}/ALL/proxy.txt`;
const RESULT_JSON = `${RESULT_DIR}/proxy.json`;
const COUNTRY_DIR = `${RESULT_DIR}/country`;

const IP_RESOLVER_DOMAIN = "myip.ipeek.workers.dev";
const IP_RESOLVER_PATH = "/";
const CONCURRENCY = 99;

const CHECK_QUEUE: string[] = [];
let lastPercentShown = 0;

function showProgress(current: number, total: number) {
  const percent = (current / total) * 100;
  const rounded = Math.floor(percent);

  // hanya update setiap 2% atau di akhir
  if (rounded >= lastPercentShown + 2 || current === total) {
    lastPercentShown = rounded;
    const filled = Math.round((percent / 100) * 25);
    const bar = "█".repeat(filled) + "░".repeat(25 - filled);
    console.log(`🔍 Scanning [${bar}] ${percent.toFixed(1)}% (${current}/${total})`);
  }
}


// === TLS Request ===
async function sendRequest(host: string, path: string, proxy: any = null) {
  return new Promise<string>((resolve, reject) => {
    const socket = tls.connect(
      { host: proxy ? proxy.host : host, port: proxy ? proxy.port : 443, servername: host },
      () => {
        socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: Mozilla\r\nConnection: close\r\n\r\n`);
      },
    );

    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("timeout"));
    }, 5000);

    socket.on("data", (d) => (response += d.toString()));
    socket.on("end", () => {
      clearTimeout(timeout);
      resolve(response.split("\r\n\r\n")[1] || "");
    });
    socket.on("error", reject);
  });
}

// === Cek proxy ===
async function checkProxy(address: string, port: number): Promise<ProxyTestResult> {
  let result: ProxyTestResult = { error: true, message: "Unknown" };

  try {
    const start = Date.now();
    const [ipinfo, myipRaw] = await Promise.all([
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, { host: address, port }),
      myGeoIpString == null ? sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH) : Promise.resolve(myGeoIpString),
    ]);
    const end = Date.now();

    if (myGeoIpString == null) myGeoIpString = myipRaw;

    const parsedIpInfo = JSON.parse(ipinfo);
    const parsedMyIp = JSON.parse(myGeoIpString);

    if (parsedIpInfo.ip && parsedIpInfo.ip !== parsedMyIp.ip) {
      result = {
        error: false,
        result: {
          proxy: address,
          port,
          proxyip: true,
          delay: end - start,
          ...parsedIpInfo,
        },
      };
    }
  } catch (e: any) {
    result.message = e.message;
  }

  return result;
}

// === Baca daftar proxy dari SOURCE ===
async function readProxyList(): Promise<ProxyStruct[]> {
  const proxyList: ProxyStruct[] = [];
  const text = await file(SOURCE_FILE).text();
  const lines = text.split("\n").filter(Boolean);

  for (const line of lines) {
    const [address, port, country, org] = line.split(",");
    if (!address || !port) continue;
    proxyList.push({ address, port: parseInt(port), country, org });
  }

  return proxyList;
}

// === Sort helper ===
function sortByCountry(a: string, b: string) {
  const ca = a.split(",")[2];
  const cb = b.split(",")[2];
  return ca.localeCompare(cb);
}

// === MAIN ===
(async () => {
  await mkdir(`${RESULT_DIR}/ALL`, { recursive: true });
  await mkdir(COUNTRY_DIR, { recursive: true });

  const proxyList = await readProxyList();
  const proxyChecked: string[] = [];
  const uniqueRaw: string[] = [];
  const activeList: string[] = [];
  const kvPair: Record<string, string[]> = {};

  let proxySaved = 0;

  for (let i = 0; i < proxyList.length; i++) {
    const proxy = proxyList[i];
    const proxyKey = `${proxy.address}:${proxy.port}`;

    // progress update
    showProgress(i + 1, proxyList.length);

    if (proxyChecked.includes(proxyKey)) continue;
    proxyChecked.push(proxyKey);

    uniqueRaw.push(`${proxy.address},${proxy.port},${proxy.country},${proxy.org?.replace(/\+/g, " ")}`);

    CHECK_QUEUE.push(proxyKey);
    checkProxy(proxy.address, proxy.port)
      .then((res) => {
        if (!res.error && res.result?.proxyip === true && res.result.country) {
          activeList.push(`${res.result.proxy},${res.result.port},${res.result.country},${res.result.asOrganization}`);

          if (!kvPair[res.result.country]) kvPair[res.result.country] = [];
          if (kvPair[res.result.country].length < 10) {
            kvPair[res.result.country].push(`${res.result.proxy}:${res.result.port}`);
          }

          proxySaved++;
        }
      })
      .finally(() => CHECK_QUEUE.pop());

    while (CHECK_QUEUE.length >= CONCURRENCY) await Bun.sleep(10);
  }

  // Tunggu semua selesai
  while (CHECK_QUEUE.length) await Bun.sleep(10);

  // Sort hasil
  uniqueRaw.sort(sortByCountry);
  activeList.sort(sortByCountry);

  // Simpan hasil utama
  await write(RESULT_JSON, JSON.stringify(kvPair, null, 2));
  await write(SOURCE_FILE, uniqueRaw.join("\n"));
  await write(RESULT_ALL, activeList.join("\n"));

  console.log(`\n📦 Total proxy aktif: ${proxySaved}`);

  // === Pisah per negara ===
  const allData = await file(RESULT_ALL).text();
  const countryMap: Record<string, string[]> = {};

  for (const line of allData.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(",");
    const country = parts[2]?.trim();
    if (!country) continue;
    if (!countryMap[country]) countryMap[country] = [];
    countryMap[country].push(line);
  }

  for (const [country, lines] of Object.entries(countryMap)) {
    const filePath = `${COUNTRY_DIR}/${country}.txt`;
    await write(filePath, lines.join("\n"));
  }

  console.log(`✅ Proxy berhasil dipisah ke folder ${COUNTRY_DIR}`);
  console.log(`🕒 Proses selesai dalam ${(Bun.nanoseconds() / 1e9).toFixed(2)} detik\n`);
})();
