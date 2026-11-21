/**
 * Nombres de campeón de la hoja comunitaria de clears ("Kha'Zix", "Nunu &
 * Willump", "Wukong") frente a los ids de Riot ("Khazix", "Nunu", "MonkeyKing")
 * que usan las partidas y los retratos que viajan en `public/champions`.
 */

/** Clave para comparar: solo letras, en minúscula, con los dos nombres internos
 *  que no se parecen al visible. La misma que `clave_campeon` en Rust. */
export const claveCampeon = (n: string): string => {
  const k = n.toLowerCase().replace(/[^a-z]/g, "");
  return k === "monkeyking" ? "wukong" : k === "nunu" ? "nunuwillump" : k;
};

/** Los retratos locales (`public/champions/<id>.png`). Si sale un campeón
 *  nuevo que no está, el retrato lo busca el CDN por su nombre. */
const IDS = [
  "Aatrox", "Ahri", "Akali", "Akshan", "Alistar", "Ambessa", "Amumu", "Anivia", "Annie",
  "Aphelios", "Ashe", "AurelionSol", "Aurora", "Azir", "Bard", "Belveth", "Blitzcrank", "Brand",
  "Braum", "Briar", "Caitlyn", "Camille", "Cassiopeia", "Chogath", "Corki", "Darius", "Diana",
  "DrMundo", "Draven", "Ekko", "Elise", "Evelynn", "Ezreal", "Fiddlesticks", "Fiora", "Fizz",
  "Galio", "Gangplank", "Garen", "Gnar", "Gragas", "Graves", "Gwen", "Hecarim", "Heimerdinger",
  "Hwei", "Illaoi", "Irelia", "Ivern", "Janna", "JarvanIV", "Jax", "Jayce", "Jhin", "Jinx",
  "KSante", "Kaisa", "Kalista", "Karma", "Karthus", "Kassadin", "Katarina", "Kayle", "Kayn",
  "Kennen", "Khazix", "Kindred", "Kled", "KogMaw", "Leblanc", "LeeSin", "Leona", "Lillia",
  "Lissandra", "Locke", "Lucian", "Lulu", "Lux", "Malphite", "Malzahar", "Maokai", "MasterYi",
  "Mel", "Milio", "MissFortune", "MonkeyKing", "Mordekaiser", "Morgana", "Naafiri", "Nami",
  "Nasus", "Nautilus", "Neeko", "Nidalee", "Nilah", "Nocturne", "Nunu", "Olaf", "Orianna", "Ornn",
  "Pantheon", "Poppy", "Pyke", "Qiyana", "Quinn", "Rakan", "Rammus", "RekSai", "Rell", "Renata",
  "Renekton", "Rengar", "Riven", "Rumble", "Ryze", "Samira", "Sejuani", "Senna", "Seraphine",
  "Sett", "Shaco", "Shen", "Shyvana", "Singed", "Sion", "Sivir", "Skarner", "Smolder", "Sona",
  "Soraka", "Swain", "Sylas", "Syndra", "TahmKench", "Taliyah", "Talon", "Taric", "Teemo",
  "Thresh", "Tristana", "Trundle", "Tryndamere", "TwistedFate", "Twitch", "Udyr", "Urgot", "Varus",
  "Vayne", "Veigar", "Velkoz", "Vex", "Vi", "Viego", "Viktor", "Vladimir", "Volibear", "Warwick",
  "Xayah", "Xerath", "XinZhao", "Yasuo", "Yone", "Yorick", "Yunara", "Yuumi", "Zaahen", "Zac",
  "Zed", "Zeri", "Ziggs", "Zilean", "Zoe", "Zyra",
];

const POR_CLAVE = new Map(IDS.map((id) => [claveCampeon(id), id]));

/** Id de Riot para el retrato; si no lo conoce, el nombre tal cual. */
export const idCampeon = (nombre: string): string => POR_CLAVE.get(claveCampeon(nombre)) ?? nombre;
