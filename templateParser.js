/* templateParser.js
   Single-table approach where each entry's `search` can be:
     - plain string (fast exact key lookup)
     - RegExp (regex lookup)
     - string in slash form "/.../" (converted to RegExp)

   I2C / LED-driver detection logic integrated.
   This version restores the exact informational lines present in the original
   templateParser.js (device name, manufacturer, module/chip) so no output is
   suppressed compared to the original.
*/

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findUserParamKey(js) {
  if (js.user_param_key !== undefined) return js.user_param_key;
  if (js.device_configuration !== undefined) return js.device_configuration;
  return js;
}

function normalizeSearch(spec) {
  // spec.search: RegExp | string ("/.../") | plain key
  if (spec.search instanceof RegExp) {
    const flags = spec.search.flags.replace('g', '');
    return { ...spec, _searchType: 'regex', _regex: new RegExp(spec.search.source, flags) };
  }
  if (typeof spec.search === 'string') {
    const s = spec.search;
    // slash-literal string -> RegExp
    if (s.length >= 2 && s[0] === '/' && s[s.length - 1] === '/') {
      const body = s.slice(1, -1);
      return { ...spec, _searchType: 'regex', _regex: new RegExp(body) };
    }
    // plain string -> exact key lookup
    return { ...spec, _searchType: 'key', _key: s };
  }
  throw new Error('spec.search must be RegExp or string');
}

function extractNumberFromMatch(match, spec) {
  if (!match) return null;
  if (spec && spec.groupName && match.groups && match.groups[spec.groupName] !== undefined) {
    const val = match.groups[spec.groupName];
    return val === '' ? null : Number(val);
  }
  const idx = (spec && typeof spec.group === 'number') ? spec.group : 1;
  const raw = match[idx];
  return (raw === '' || raw === undefined) ? null : Number(raw);
}

function makeSetPinLines(pinId, role, channel, nochan) {
  if (nochan) return [`setPinRole ${pinId} ${role}`];
  return [`backlog setPinRole ${pinId} ${role}; setPinChannel ${pinId} ${channel}`];
}

/*
 PROCESSING_TABLE_RAW
 - search: string | RegExp | "/regex/" form
 - role: string or null
 - desc: template using {number} and {value}
 - nochan: boolean (optional)
 - channel: fixed channel (optional)
 - group / groupName: capture group specification for regex (optional)
 - special: "i2c" for the I2C LED/driver handler
*/

/* Many keys/patterns below were derived from TuyaConfig.cs (BK7231Flasher) analysis.
   Comments mark where entries correspond to matches in that C# file.
*/
const PROCESSING_TABLE_RAW = [
  // Regex patterns (channel-capturing)
  { search: /^rl_on(\d+)_pin$/, role: "Rel", desc: "- Bridge Relay On (channel {number}) on P{value}" }, // C#: ^rl_on\d+_pin$
  { search: /^rl_off(\d+)_pin$/, role: "Rel_n", desc: "- Bridge Relay Off (channel {number}) on P{value}" }, // C#: ^rl_off\d+_pin$
  { search: /^rl(\d+)_pin$/, role: "Rel", desc: "- Relay (channel {number}) on P{value}" }, // C#: ^rl\d+_pin$
  { search: /^led(\d+)_pin$/, role: "LED", desc: "- LED (channel {number}) on P{value}" }, // C#: ^led\d+_pin$
  { search: /^door(\d+)_magt_pin$/, role: "dInput", desc: "- Door Sensor (channel {number}) on P{value}" }, // C#: ^door\d+_magt_pin$
  { search: /^bt(\d+)_pin$/, role: "Btn", desc: "- Button (channel {number}) on P{value}" }, // C#: ^bt\d+_pin$
  { search: /^k(\d+)pin_pin$/, role: "Btn", desc: "- Button (channel {number}) on P{value}" }, // C#: ^k\d+pin_pin$
  { search: /^onoff(\d+)$/, role: "TglChanOnTgl", desc: "- TglChannelToggle (channel {number}) on P{value}" }, // C#: ^onoff\d+$

  // netled may be netled_pin or netled1_pin etc. use regex form (optional number)
  { search: "/^netled(\\d*)_pin$/", role: "WifiLED_n", desc: "- WiFi LED on P{value}", nochan: true }, // C#

  // Exact keys and aliases (straight lookup) discovered in C#:
  { search: "gate_sensor_pin_pin", role: "dInput", desc: "- Door/Gate Sensor on P{value}", nochan: true }, // C#
  { search: "basic_pin_pin", role: "dInput", desc: "- PIR sensor on P{value}", nochan: true }, // C#
  { search: "ele_pin", role: "BL0937CF", desc: "- BL0937 ELE on P{value}", nochan: true }, // C#
  { search: "epin", role: "BL0937CF", desc: "- EPIN (alias for ele_pin) on P{value}", nochan: true }, // C# alias
  { search: "vi_pin", role: "BL0937CF1", desc: "- BL0937 VI on P{value}", nochan: true }, // C#
  { search: "ivpin", role: "BL0937CF1", desc: "- BL0937 VI (ivpin) on P{value}", nochan: true }, // C# alias
  { search: "sel_pin_pin", role: "BL0937SEL", desc: "- BL0937 SEL on P{value}", nochan: true }, // C#
  { search: "ivcpin", role: "BL0937SEL", desc: "- BL0937 SEL (ivcpin) on P{value}", nochan: true }, // C# alias
  { search: "wfst_pin", role: "WifiLED_n", desc: "- WiFi LED on P{value}", nochan: true }, // C#
  { search: "wfst", role: "WifiLED_n", desc: "- WiFi LED (wfst) on P{value}", nochan: true }, // C# plain 'wfst' alternative
  { search: "infrr", role: "IRRecv", desc: "- IR Receiver on P{value}", nochan: true }, // C#
  { search: "infre", role: "IRSend", desc: "- IR Sender on P{value}", nochan: true }, // C#
  { search: "remote_io", role: "RCRecv", desc: "- RF Remote on P{value}", nochan: true }, // C#
  { search: "r_pin", role: "PWM", desc: "- LED Red (Channel 1) on P{value}", channel: 1 }, // C# used channel 0 in BK code !!! Also next ones keep one below
  { search: "g_pin", role: "PWM", desc: "- LED Green (Channel 2) on P{value}", channel: 2 }, // C#
  { search: "b_pin", role: "PWM", desc: "- LED Blue (Channel 3) on P{value}", channel: 3 }, // C#
  { search: "c_pin", role: "PWM", desc: "- LED Cool (Channel 4) on P{value}", channel: 4 }, // C#
  { search: "w_pin", role: "PWM", desc: "- LED Warm (Channel 5) on P{value}", channel: 5 }, // C#
  { search: "mic", role: "ADC", desc: "- Microphone (ADC?) Pin on P{value}", nochan: true }, // C#
  { search: "micpin", role: "ADC", desc: "- Microphone (micpin) on P{value}", nochan: true }, // C# alias
  { search: "ctrl_pin", role: null, desc: "- Control Pin (TODO) on P{value}", nochan: true }, // C#
  { search: "total_bt_pin", role: "Btn_Tgl_All", desc: "- Pair/Toggle All Pin on P{value}", nochan: true }, // C#
  { search: "reset_pin", role: "Btn", desc: "- Pair/Reset All Pin on P{value}", nochan: true }, // C#
  { search: "key_pin", role: "Btn_Tgl_All", desc: "- Pair/Toggle All Pin on P{value}", nochan: true }, // C#
  { search: "bt_pin", role: "Btn", desc: "- Button (channel 0) on P{value}", channel: 0 }, // C#
  { search: "bt", role: "Btn", desc: "- Button (bt) on P{value}", channel: 0 }, // C#
  { search: "rl", role: "Rel", desc: "- Relay (channel 0) on P{value}", channel: 0 }, // C#
  { search: "samp_sw_pin", role: "BAT_Relay", desc: "- Battery Relay on P{value}", nochan: true }, // C#
  { search: "samp_pin", role: "BAT_ADC", desc: "- Battery ADC on P{value}", nochan: true }, // C#
  { search: "i2c_scl_pin", role: "I2C_SCL", desc: "- I2C SCL on P{value}", nochan: true }, // C#
  { search: "i2c_sda_pin", role: "I2C_SDA", desc: "- I2C SDA on P{value}", nochan: true }, // C#
  { search: "alt_pin_pin", role: "ALT", desc: "- ALT pin on P{value}", nochan: true }, // C#
  { search: "one_wire_pin", role: "OneWire", desc: "- OneWire IO pin on P{value}", nochan: true }, // C#
  { search: "backlit_io_pin", role: "LED", desc: "- Backlit IO pin on P{value}", nochan: true }, // C#
  { search: "max_V", role: null, desc: "- Battery Max Voltage: {value}", nochan: true }, // C#
  { search: "min_V", role: null, desc: "- Battery Min Voltage: {value}", nochan: true }, // C#
  { search: "pwmhz", role: null, desc: "- PWM Frequency {value}", nochan: true }, // C#
  // PIR-related keys (settings, not pins)
  { search: "pirsense_pin", role: null, desc: "- PIR Sensitivity {value}", nochan: true }, // C#
  { search: "pirlduty", role: null, desc: "- PIR Low Duty {value}", nochan: true }, // C#
  { search: "pirfreq", role: null, desc: "- PIR Frequency {value}", nochan: true }, // C#
  { search: "pirmduty", role: null, desc: "- PIR High Duty {value}", nochan: true }, // C#
  { search: "pirin_pin", role: null, desc: "- PIR Input {value}", nochan: true }, // C#

  // SPI pins (mosi/miso/SCL/CS)
  { search: "mosi", role: "SM16703P_DIN", desc: "- SPI MOSI P{value}", nochan: true }, // C#
  { search: "miso", role: null, desc: "- SPI MISO P{value}", nochan: true }, // C#
  { search: "SCL", role: null, desc: "- SPI SCL P{value}", nochan: true }, // C#
  { search: "CS", role: null, desc: "- SPI CS P{value}", nochan: true }, // C#

  // Buzzer related keys (from C# cases)
  { search: "buzzer_io", role: null, desc: "- Buzzer Pin (TODO) on P{value}", nochan: true }, // C#
  { search: "bz_pin_pin", role: null, desc: "- Buzzer Pin (bz_pin_pin) on P{value}", nochan: true }, // C# alias
  { search: "status_led_pin", role: "WifiLED_n", desc: "- Status LED on P{value}", nochan: true }, // C#

  // Baud and related
  { search: "baud", role: null, desc: "UART baud {value}", nochan: true }, // C# looked at baud
  { search: "baud_cfg", role: null, desc: "baud_cfg present", nochan: true }, // C# references baud_cfg earlier

  // I2C detection trigger - handled by special handler after table processing
  { search: "iicscl", role: null, desc: "- I2C SCL (iicscl) on P{value}", nochan: true, special: "i2c" }, // original code used iicscl/iicsda
  { search: "iicsda", role: null, desc: "- I2C SDA (iicsda) on P{value}", nochan: true, special: "i2c" } // original code used iicscl/iicsda
];

// Normalize once to speed runtime
const PROCESSING_TABLE = PROCESSING_TABLE_RAW.map(normalizeSearch);

// I2C/LED detection handler (moved from earlier special block)
// It examines many iic... keys to decide ledType and produce structured entries + script/desc
function handleI2cBlock(user_param_key, pinEntries, description, script, tmpl) {
  const iicscl = user_param_key.iicscl ?? user_param_key["iicscl"];
  const iicsda = user_param_key.iicsda ?? user_param_key["iicsda"];
  if (iicscl === undefined || iicsda === undefined) return;

  const iicr = user_param_key.iicr ?? user_param_key["iicr"] ?? "-1";
  const iicg = user_param_key.iicg ?? user_param_key["iicg"] ?? "-1";
  const iicb = user_param_key.iicb ?? user_param_key["iicb"] ?? "-1";
  const iicc = user_param_key.iicc ?? user_param_key["iicc"] ?? "-1";
  const iicw = user_param_key.iicw ?? user_param_key["iicw"] ?? "-1";

  let ledType = "Unknown";
  const iicccur = user_param_key.iicccur ?? "";
  const iicwcur = user_param_key.iicwcur ?? "";
  const campere = user_param_key.campere ?? "";
  const wampere = user_param_key.wampere ?? "";
  const ehccur = user_param_key.ehccur ?? "";
  const ehwcur = user_param_key.ehwcur ?? "";
  const drgbcur = user_param_key.drgbcur ?? "";
  const dwcur = user_param_key.dwcur ?? "";
  const dccur = user_param_key.dccur ?? "";
  const cjwcur = user_param_key.cjwcur ?? "";
  const cjccur = user_param_key.cjccur ?? "";
  const _2235ccur = user_param_key["2235ccur"] ?? "";
  const _2235wcur = user_param_key["2235wcur"] ?? "";
  const _2335ccur = user_param_key["2335ccur"] ?? "";
  const kp58wcur = user_param_key["kp58wcur"] ?? "";
  const kp58ccur = user_param_key["kp58ccur"] ?? "";

  // Use current (color/cw) settings to decide driver
  if (ehccur.length > 0 || wampere.length > 0 || iicccur.length > 0) {
    ledType = "SM2135";
    // emit init lines if numeric values present
    let rgbcurrent = 1, cwcurrent = 1;
    try {
      rgbcurrent = ehccur.length > 0 ? Number(ehccur) : (iicccur.length > 0 ? Number(iicccur) : (campere.length > 0 ? Number(campere) : 1));
      cwcurrent = ehwcur.length > 0 ? Number(ehwcur) : (iicwcur.length > 0 ? Number(iicwcur) : (wampere.length > 0 ? Number(wampere) : 1));
      script.push(`SM2135_Current ${rgbcurrent} ${cwcurrent}`);
    } catch (ex) {
      // ignore numeric parse errors
    }
  } else if (dccur.length > 0) {
    ledType = "BP5758D_";
    try {
      const rgbcurrent = drgbcur.length > 0 ? Number(drgbcur) : 1;
      const wcurrent = dwcur.length > 0 ? Number(dwcur) : 1;
      const ccurrent = dccur.length > 0 ? Number(dccur) : 1;
      script.push(`BP5758D_Current ${rgbcurrent} ${Math.max(wcurrent, ccurrent)}`);
    } catch { }
  } else if (cjwcur.length > 0) {
    ledType = "BP1658CJ_";
    try {
      const rgbcurrent = cjccur.length > 0 ? Number(cjccur) : 1;
      const cwcurrent = cjwcur.length > 0 ? Number(cjwcur) : 1;
      script.push(`BP1658CJ_Current ${rgbcurrent} ${cwcurrent}`);
    } catch { }
  } else if (_2235ccur.length > 0) {
    ledType = "SM2235";
    try {
      const rgbcurrent = Number(_2235ccur || "1");
      const cwcurrent = Number(_2235wcur || "1");
      script.push(`SM2235_Current ${rgbcurrent} ${cwcurrent}`);
    } catch { }
  } else if (kp58wcur.length > 0) {
    ledType = "KP18058_";
    try {
      const rgbcurrent = Number(kp58wcur || "1");
      const cwcurrent = Number(kp58ccur || "1");
      script.push(`KP18058_Current ${rgbcurrent} ${cwcurrent}`);
    } catch { }
  } else {
    // leave Unknown
  }

  const dat_name = `${ledType}DAT`;
  const clk_name = `${ledType}CLK`;

  description.push(`- ${dat_name} on P${iicsda}`);
  description.push(`- ${clk_name} on P${iicscl}`);

  // Build map string; try numeric parse but fallback to original
  let map = `${iicr} ${iicg} ${iicb} ${iicc} ${iicw}`;
  try {
    map = `${Number(iicr)} ${Number(iicg)} ${Number(iicb)} ${Number(iicc)} ${Number(iicw)}`;
    script.push(`LED_Map ${map}`);
  } catch {
    script.push(`LED_Map ${map}`);
  }

  // push driver start and setPinRole lines
  script.unshift(`startDriver ${ledType.replace("_", "")} // so we have led_map available`);
  script.push(`setPinRole ${iicsda} ${dat_name}`);
  script.push(`setPinRole ${iicscl} ${clk_name}`);

  // push structured pin entries for iics pins
  pinEntries.push({
    key: "iicsda",
    value: iicsda,
    role: dat_name,
    number: 0,
    nochan: true,
    desc: `- ${dat_name} on P${iicsda}`,
    scriptLines: [`setPinRole ${iicsda} ${dat_name}`],
    pinId: String(iicsda)
  });
  pinEntries.push({
    key: "iicscl",
    value: iicscl,
    role: clk_name,
    number: 0,
    nochan: true,
    desc: `- ${clk_name} on P${iicscl}`,
    scriptLines: [`setPinRole ${iicscl} ${clk_name}`],
    pinId: String(iicscl)
  });

  // also record in tmpl.pins for compatibility
  tmpl.pins[String(iicsda)] = `${dat_name};0`;
  tmpl.pins[String(iicscl)] = `${clk_name};0`;
}

function processTableEntries(user_param_key, tmpl) {
  const pinEntries = [];
  const description = [];
  const script = [];
  
  // --- special handling for BL0937SEL_n (if sel_pin_lv == 0) ---
  const useBL0937SEL_n = (user_param_key.sel_pin_lv !== undefined && Number(user_param_key.sel_pin_lv) === 0) ? 1 : 0;


  for (spec of PROCESSING_TABLE) {
    if (spec._searchType === 'key') {
      // exact lookup
      const k = spec._key;
      const val = user_param_key[k];
      if (val === undefined) continue;
      // if this spec is special i2c trigger, we'll handle later (but still collect desc)
      if (spec.special === "i2c") {
        // add a small description so it's visible; full handling below
        description.push((spec.desc || "").replace("{value}", val));
        // don't add script lines here - i2c block will produce them
        // but still add a placeholder entry (so user sees the pin mapped)
        pinEntries.push({ key: k, value: val, role: spec.role, number: null, nochan: true, desc: (spec.desc || "").replace("{value}", val), scriptLines: [], pinId: String(val) });
        continue;
      }
      // --- special handling for BL0937SEL_n (if sel_pin_lv == 0) ---
      if (spec.role == "BL0937SEL" && useBL0937SEL_n == 1){
        spec.role = "BL0937SEL_n";
        spec.desc = spec.desc.replace("SEL","SEL_n");
      }

      const channel = (typeof spec.channel === 'number') ? spec.channel : (spec.nochan ? null : 0);
      const nochan = !!spec.nochan;
      const descLine = (spec.desc || "").replace("{value}", val).replace("{number}", channel === null ? "" : String(channel));
      const scriptLines = spec.role ? makeSetPinLines(val, spec.role, channel || 0, nochan) : (k === "ctrl_pin" ? [`// TODO: ctrl on ${val}`] : []);
      const entry = { key: k, value: val, role: spec.role, number: channel, nochan, desc: descLine, scriptLines, pinId: String(val) };
      pinEntries.push(entry);
      description.push(descLine);
      scriptLines.forEach(l => script.push(l));
    } else if (spec._searchType === 'regex') {
      // iterate keys and match regex
      for (const k in user_param_key) {
        const m = k.match(spec._regex);
        if (!m) continue;
        const val = user_param_key[k];
        if (val === undefined) continue;
        const number = extractNumberFromMatch(m, spec);
        const nochan = !!spec.nochan || number === null;
        const descLine = (spec.desc || "").replace("{value}", val).replace("{number}", number === null ? "" : String(number));
        const channelForScript = number === null ? 0 : number;
        const scriptLines = spec.role ? makeSetPinLines(val, spec.role, channelForScript, nochan) : [];
        const pinEntry = { key: k, value: val, role: spec.role, number, nochan, desc: descLine, scriptLines, pinId: String(val) };
        pinEntries.push(pinEntry);
        description.push(descLine);
        scriptLines.forEach(l => script.push(l));
      }
    }
  }

  // After processing all specs, run special I2C handler if iicscl/iicsda present
  if ((user_param_key.iicscl !== undefined || user_param_key.iicsda !== undefined)) {
    handleI2cBlock(user_param_key, pinEntries, description, script, tmpl);
  } else {
    // Also check "i2c_scl_pin" / "i2c_sda_pin" variants (C# used these names)
    if (user_param_key.i2c_scl_pin !== undefined || user_param_key.i2c_sda_pin !== undefined) {
      if (user_param_key.i2c_scl_pin !== undefined) user_param_key.iicscl = user_param_key.i2c_scl_pin;
      if (user_param_key.i2c_sda_pin !== undefined) user_param_key.iicsda = user_param_key.i2c_sda_pin;
      handleI2cBlock(user_param_key, pinEntries, description, script, tmpl);
    }
  }

  return { pinEntries, description, script };
}

function processJSON_UserParamKeyStyle(js, user_param_key) {
  const tmpl = {
    vendor: "Tuya",
    bDetailed: "0",
    name: "TODO",
    model: "TODO",
    chip: "BK7231T",
    board: "TODO",
    keywords: [],
    pins: {},
    command: "",
    image: "https://obrazki.elektroda.pl/YOUR_IMAGE.jpg",
    wiki: "https://www.elektroda.com/rtvforum/topic_YOUR_TOPIC.html",
    flags: js.flags
  };

  // preserve original informational lines from the original templateParser.js
  const description = [];
  const script = [];

  if (js.name !== undefined) {
    tmpl.name = js.name;
    // Original code: desc += "Device name seems to be " + js.name +"\n";
    description.push("Device name seems to be " + js.name);
  }
  if (js.manufacturer !== undefined) {
    tmpl.vendor = js.manufacturer;
    // Original code: desc += "Device manufacturer seems to be " + js.manufacturer +"\n";
    description.push("Device manufacturer seems to be " + js.manufacturer);
  }
  if (js.module !== undefined) {
    tmpl.board = js.module;
    if (tmpl.board[0] === 'C' || tmpl.board[0] === 'T') tmpl.chip = "BK7231N";
    if (tmpl.board[0] === 'W') tmpl.chip = "BK7231T";
    // Original code: desc += "Device seems to be using " + tmpl.board + " module, which is " + tmpl.chip + " chip."+"\n";
    description.push("Device seems to be using " + tmpl.board + " module, which is " + tmpl.chip + " chip.");
  }

  // Run table (pass tmpl so i2c handler can modify tmpl.pins)
  const { pinEntries, description: descFromTable, script: scriptFromTable } = processTableEntries(user_param_key, tmpl);

  // merge table-generated description/script into initial description/script preserving order:
  // original behavior appended pin descriptions after those top lines, so do the same.
  descFromTable.forEach(d => description.push(d));
  scriptFromTable.forEach(s => script.push(s));

  // misc info lines (these were previously appended after pin processing)
  if (user_param_key["baud"] !== undefined) {
    description.push(`This device seems to be using UART at ${user_param_key["baud"]}, maybe it's TuyaMCU or BL0942?`);
  }
  if (user_param_key["buzzer_io"] !== undefined) {
    description.push(`There is a buzzer on P${user_param_key["buzzer_io"]}`);
  }
  if (user_param_key["buzzer_pwm"] !== undefined) {
    description.push(`Buzzer frequency is ${user_param_key["buzzer_pwm"]}Hz`);
  }
  if (user_param_key.ele_rx !== undefined) {
    description.push(`- BL0942 (?) RX on P${user_param_key.ele_rx}`);
    description.push(`- BL0942 (?) TX on P${user_param_key.ele_tx}`);
    script.push(`StartupCommand "startDriver BL0942"`);
  }


  // Build tmpl.pins in legacy "role;channel" string format for compatibility
  pinEntries.forEach(e => {
    tmpl.pins[e.pinId] = `${e.role || "Unknown"};${e.number === null ? 0 : e.number}`;
  });

  return {
    tmpl,
    pins: pinEntries,
    description,
    script,
    // legacy strings kept for compatibility with callers expecting desc/scr
    desc: description.join("\n"),
    scr: script.join("\n")
  };
}

function processJSON_OpenBekenTemplateStyle(tmpl) {
  const pinEntries = [];
  const description = [];
  const script = [];

  for (const pin in tmpl.pins) {
    const pinDesc = tmpl.pins[pin];
    const [roleNameRaw, channelRaw, channel2Raw] = pinDesc.split(';');
    let roleName = roleNameRaw;
    const channel = channelRaw !== undefined ? Number(channelRaw) : 0;
    const channel2 = channel2Raw !== undefined ? Number(channel2Raw) : 0;

    // remap some old convention
    if (roleName === "Button") roleName = "Btn";
    if (roleName === "Button_n") roleName = "Btn_n";
    if (roleName === "Relay") roleName = "Rel";
    if (roleName === "Relay_n") roleName = "Rel_n";

    const descLine = `- P${pin} is ${roleName} on channel ${channel}`;
    description.push(descLine);

    let scriptLine = `backlog setPinRole ${pin} ${roleName}; setPinChannel ${pin} ${channel}`;
    if (channel2 !== 0 && !Number.isNaN(channel2)) scriptLine += ` ${channel2}`;
    script.push(scriptLine);

    pinEntries.push({
      key: `P${pin}`,
      value: pin,
      role: roleName,
      number: channel,
      extra: channel2,
      nochan: false,
      desc: descLine,
      scriptLines: [scriptLine],
      pinId: String(pin)
    });
  }

  if (tmpl.flags !== undefined) {
    script.push(`Flags ${tmpl.flags}`);
    description.push(`- Flags are set to ${tmpl.flags}`);
  }
  if (tmpl.command !== undefined && tmpl.command.length > 0) {
    script.push(`StartupCommand "${tmpl.command}"`);
    description.push(`- StartupCommand is set to ${tmpl.command}`);
  }

  return {
    tmpl,
    pins: pinEntries,
    description,
    script,
    desc: description.join("\n"),
    scr: script.join("\n")
  };
}

function fetchJSONSync(url) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', url, false); // synchronous
  xhr.send();
  if (xhr.status === 200) return xhr.responseText;
  throw new Error('Failed to fetch JSON: ' + xhr.status);
}

function processJSONInternal(txt) {
  const js = JSON.parse(txt);
  if (js.pins !== undefined && js.chip !== undefined && js.board !== undefined) {
    return processJSON_OpenBekenTemplateStyle(js);
  }
  const user_param_key = findUserParamKey(js);
  return processJSON_UserParamKeyStyle(js, user_param_key);
}

function processJSON(txt) {
  if (typeof txt === "string" && txt.startsWith("http")) {
    txt = fetchJSONSync(txt);
  }
  return processJSONInternal(txt);
}

// Helper to make safe filenames
function sanitizeFilename(name) {
  if (!name) name = "unknown";
  name = name.replace(/[<>:"/\\|?*\s.,&#+-]/g, "_");
  name = name.replace(/_+/g, "_");
  name = name.replace(/^_+|_+$/g, "");
  return name || "unknown";
}

function pageNameForDevice(device) {
  const start = (device.vendor || "Unknown");
  const sub = (device.model || device.name || "NA");
  const baseName = (sub.startsWith(start) ? sub : `${start}_${sub}`);
  return sanitizeFilename(baseName);
}

// UMD export wrapper
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(); // Node.js
  } else {
    root.TemplateParser = factory(); // Browser
  }
}(typeof self !== 'undefined' ? self : this, function () {

  return {
    processJSON_OpenBekenTemplateStyle,
    processJSON_UserParamKeyStyle,
    processJSON,
    processJSONInternal,
    pageNameForDevice,
    sanitizeFilename,
    // Export the raw and normalized table so callers can inspect/extend
    PROCESSING_TABLE_RAW,
    PROCESSING_TABLE
  };
}));
