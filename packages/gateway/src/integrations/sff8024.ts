// SFF-8024 local store
// Source: SFF-8024 Rev 4.10 (November 2021) — Transceiver Management

// Identifier Values (Table 4-1)
export const IDENTIFIER_CODES: Record<string, string> = {
  '00': 'Unknown or unspecified',
  '01': 'GBIC',
  '02': 'Module/connector soldered to motherboard',
  '03': 'SFP/SFP+/SFP28',
  '04': '300 pin XBI',
  '05': 'XENPAK',
  '06': 'XFP',
  '07': 'XFF',
  '08': 'XFP-E',
  '09': 'XPAK',
  '0A': 'X2',
  '0B': 'DWDM-SFP/SFP+ (not using SFF-8472)',
  '0C': 'QSFP (INF-8438)',
  '0D': 'QSFP+ or later (SFF-8436, SFF-8635, SFF-8665, SFF-8685 et al)',
  '0E': 'CXP or later (INF-8644 et al)',
  '0F': 'Shielded Mini Multilane HD 4X',
  '10': 'Shielded Mini Multilane HD 8X',
  '11': 'QSFP28 or later (SFF-8665 et al)',
  '12': 'CXP2 (aka CXP28) or later',
  '13': 'CDFP (Style 1/Style 2)',
  '14': 'Shielded Mini Multilane HD 4X Fanout Cable',
  '15': 'Shielded Mini Multilane HD 8X Fanout Cable',
  '16': 'CDFP (Style 3)',
  '17': 'microQSFP',
  '18': 'QSFP-DD Double Density 8X Pluggable Transceiver (INF-8628)',
  '19': 'OSFP 8X Pluggable Transceiver',
  '1A': 'SFP-DD Double Density 2X Pluggable Transceiver',
  '1B': 'DSFP Dual Small Form Factor Pluggable Transceiver',
  '1C': 'x4 Minilink/OcuLink',
  '1D': 'x8 Minilink',
  '1E': 'QSFP+ or later (SFF-8436, SFF-8635 et al) with Common Management Interface Specification (CMIS)',
  '1F': 'SFP-DD (SFF-8690)',
  '20': 'DSFP (SFF-8692)',
  '21': 'QSFP-DD (SFF-8681)',
  '22': 'OSFP (SFF-8679)',
  '23': 'microSFP',
  '24': 'QSFP112 (200G per lane)',
  '25': 'OSFP-XD',
  '26': 'CSFP (Compact SFP)',
  '27': 'SFPDD (200G)',
  '28': 'SFP (SFF-8024)',
};

// Connector Types (Table 4-3)
export const CONNECTOR_CODES: Record<string, string> = {
  '00': 'Unknown or unspecified',
  '01': 'SC (Subscriber Connector)',
  '02': 'Fibre Channel Style 1 copper connector',
  '03': 'Fibre Channel Style 2 copper connector',
  '04': 'BNC/TNC (Bayonet/Threaded Neill-Concelman)',
  '05': 'Fibre Channel coax headers',
  '06': 'Fiber Jack',
  '07': 'LC (Lucent Connector)',
  '08': 'MT-RJ (Mechanical Transfer - Registered Jack)',
  '09': 'MU (Multiple Use)',
  '0A': 'SG',
  '0B': 'Optical Pigtail',
  '0C': 'MPO 1x12 (Multifiber Push On)',
  '0D': 'MPO 2x16',
  '20': 'HSSDC II (High Speed Serial Data Connector)',
  '21': 'Copper Pigtail',
  '22': 'RJ45 (Registered Jack 45)',
  '23': 'No separable connector',
  '24': 'MXC 2x16',
  '25': 'CS optical connector',
  '26': 'SN (previously Mini CS) optical connector',
  '27': 'MPO 2x12',
  '28': 'MPO 1x16',
};

// Encoding Codes (Table 4-2)
export const ENCODING_CODES: Record<string, string> = {
  '00': 'Unspecified',
  '01': '8B10B',
  '02': '4B5B',
  '03': 'NRZ',
  '04': 'Manchester',
  '05': 'SONET Scrambled',
  '06': '64B/66B',
  '07': '256B/257B (transcoded FEC-enabled data)',
  '08': 'PAM4',
  '09': 'ANSI / INCITS TR-48 (8B6T)',
  '0A': 'ANSI / INCITS TR-48 (64B/80B)',
  '0B': 'ANSI / INCITS TR-48 (64B/80B with Reed Solomon)',
  '0C': '256B/257B (transcoded FEC-enabled data) IEEE Std 802.3',
  '0D': 'PAM4 with Nyquist signaling',
};

// Extended Identifier Values (Table 4-4)
export const EXTENDED_IDENTIFIER_CODES: Record<string, string> = {
  '00': 'Power Level 1 Module (1.5W max.)',
  '01': 'Power Level 2 Module (2.0W max.)',
  '02': 'Power Level 3 Module (2.5W max.)',
  '03': 'Power Level 4 Module (3.5W max.)',
  '04': 'Power Level 5 Module (4.0W max.)',
  '05': 'Power Level 6 Module (4.5W max.)',
  '06': 'Power Level 7 Module (5.0W max.)',
  '07': 'Power Level 8 Module (10W max.)',
};

// Nominal Signaling Rate Descriptor (Table 4-9)
export const DATA_RATE_CODES: Record<string, string> = {
  '01': '100 MBd (1 Gbps Ethernet)',
  '0A': '1.0625 GBd',
  '0C': '1.25 GBd (1000BASE-X)',
  '14': '2.125 GBd',
  '1E': '2.5 GBd',
  '28': '4.25 GBd',
  '50': '8.5 GBd',
  '64': '10.3 GBd',
  '67': '10.518 GBd',
  '68': '10.5 GBd',
  '6E': '11.1 GBd',
  'FF': 'Encoded in upper 3 bits of Byte 67',
};

// Well-known transceiver type strings mapped to standard identifiers
export const FORM_FACTOR_TO_IDENTIFIER: Record<string, string> = {
  GBIC: '01',
  SFP: '03',
  'SFP+': '03',
  SFP28: '03',
  SFP56: '03',
  QSFP: '0C',
  'QSFP+': '0D',
  QSFP28: '11',
  QSFP56: '11',
  'QSFP-DD': '18',
  OSFP: '19',
  'OSFP-XD': '25',
  CXP: '0E',
  XFP: '06',
  X2: '0A',
  XENPAK: '05',
  'SFP-DD': '1A',
  DSFP: '1B',
  CDFP: '16',
};

export function getIdentifierName(code: string): string | undefined {
  return IDENTIFIER_CODES[code.toUpperCase()];
}

export function getConnectorName(code: string): string | undefined {
  return CONNECTOR_CODES[code.toUpperCase()];
}

export function getEncodingName(code: string): string | undefined {
  return ENCODING_CODES[code.toUpperCase()];
}

export function formFactorToIdentifierCode(formFactor: string): string | undefined {
  return FORM_FACTOR_TO_IDENTIFIER[formFactor.toUpperCase()];
}

export function getAllFormFactors(): string[] {
  return Object.keys(FORM_FACTOR_TO_IDENTIFIER);
}

export function getAllConnectorNames(): string[] {
  return Object.values(CONNECTOR_CODES);
}
