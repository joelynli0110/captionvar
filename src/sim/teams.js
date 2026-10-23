/**
 * Fictional clubs and squads. No real clubs, players, crests or Premier
 * League data are used anywhere in the generator.
 *
 * Base positions are in the attack frame (ax: own goal 0 -> opponent goal 100,
 * ay: 0 = left touchline from the attacker's view).
 */

const POSITION_BASE = {
  GK: { ax: 5, ay: 50 },
  RB: { ax: 30, ay: 85 },
  RCB: { ax: 22, ay: 62 },
  LCB: { ax: 22, ay: 38 },
  LB: { ax: 30, ay: 15 },
  DM: { ax: 40, ay: 50 },
  RCM: { ax: 52, ay: 66 },
  LCM: { ax: 52, ay: 34 },
  AM: { ax: 64, ay: 50 },
  RW: { ax: 72, ay: 84 },
  LW: { ax: 72, ay: 16 },
  ST: { ax: 80, ay: 50 },
};

/** Role groups drive who is likely to be on the ball in each zone. */
export const ROLE_GROUP = {
  GK: 'goalkeeper',
  RB: 'defender', RCB: 'defender', LCB: 'defender', LB: 'defender',
  DM: 'midfielder', RCM: 'midfielder', LCM: 'midfielder', AM: 'midfielder',
  RW: 'forward', LW: 'forward', ST: 'forward',
};

function player(teamCode, number, name, position, attrs) {
  return {
    id: `${teamCode}-${String(number).padStart(2, '0')}`,
    name,
    short_name: name.split(' ').slice(-1)[0],
    number,
    position,
    role_group: ROLE_GROUP[position] ?? 'midfielder',
    base: POSITION_BASE[position] ?? POSITION_BASE.RCM,
    ...attrs,
  };
}

// attrs: pace = top sprint speed km/h, passing/shooting/defending in 0..1
export const DEFAULT_TEAMS = {
  home: {
    id: 'NBR',
    name: 'Northbridge FC',
    short_name: 'Northbridge',
    formation: '4-3-3',
    colors: { primary: '#2f6fdf', secondary: '#f2f5ff' },
    style: {
      label: 'high-press possession',
      passing: 0.84,
      directness: 0.32,
      press_intensity: 0.62,
      press_height: 0.68,
      tempo: 1.0,
      finishing: 1.0,
      width: 0.6,
    },
    starters: [
      player('NBR', 1, 'Tomas Hale', 'GK', { pace: 29.5, passing: 0.62, shooting: 0.05, defending: 0.7 }),
      player('NBR', 2, 'Kofi Mensah-Reid', 'RB', { pace: 34.6, passing: 0.74, shooting: 0.25, defending: 0.72 }),
      player('NBR', 5, 'Elias Brandt', 'RCB', { pace: 31.8, passing: 0.78, shooting: 0.2, defending: 0.84 }),
      player('NBR', 6, 'Ruairi Doyle', 'LCB', { pace: 32.2, passing: 0.72, shooting: 0.22, defending: 0.82 }),
      player('NBR', 3, 'Mateo Quiroga', 'LB', { pace: 34.1, passing: 0.73, shooting: 0.28, defending: 0.7 }),
      player('NBR', 4, 'Jonah Pell', 'DM', { pace: 31.0, passing: 0.86, shooting: 0.35, defending: 0.78 }),
      player('NBR', 8, 'Sami Okafor', 'RCM', { pace: 32.9, passing: 0.84, shooting: 0.5, defending: 0.66 }),
      player('NBR', 16, 'Lior Ashkenazi', 'LCM', { pace: 32.4, passing: 0.88, shooting: 0.48, defending: 0.6 }),
      player('NBR', 7, 'Dario Vence', 'RW', { pace: 35.8, passing: 0.76, shooting: 0.68, defending: 0.35 }),
      player('NBR', 11, 'Aiden Marsh', 'LW', { pace: 35.2, passing: 0.78, shooting: 0.66, defending: 0.38 }),
      player('NBR', 9, 'Callum Reyes', 'ST', { pace: 33.9, passing: 0.7, shooting: 0.84, defending: 0.3 }),
    ],
    bench: [
      player('NBR', 13, 'Owen Frisk', 'GK', { pace: 29.0, passing: 0.58, shooting: 0.05, defending: 0.66 }),
      player('NBR', 15, 'Henrik Saul', 'RCB', { pace: 31.2, passing: 0.7, shooting: 0.2, defending: 0.78 }),
      player('NBR', 14, 'Nico Albertsen', 'LCM', { pace: 32.1, passing: 0.82, shooting: 0.44, defending: 0.62 }),
      player('NBR', 19, 'Yusuf Darby', 'RW', { pace: 36.1, passing: 0.7, shooting: 0.64, defending: 0.32 }),
      player('NBR', 20, 'Bastien Kerr', 'ST', { pace: 33.0, passing: 0.66, shooting: 0.79, defending: 0.3 }),
    ],
  },
  away: {
    id: 'RVU',
    name: 'Riverside United',
    short_name: 'Riverside',
    formation: '4-2-3-1',
    colors: { primary: '#f1efe6', secondary: '#1b1b1b' },
    style: {
      label: 'compact counter-attack',
      passing: 0.79,
      directness: 0.55,
      press_intensity: 0.42,
      press_height: 0.38,
      tempo: 0.92,
      finishing: 1.05,
      width: 0.5,
    },
    starters: [
      player('RVU', 1, 'Marek Vollan', 'GK', { pace: 29.2, passing: 0.6, shooting: 0.05, defending: 0.74 }),
      player('RVU', 2, 'Theo Abara', 'RB', { pace: 34.0, passing: 0.7, shooting: 0.24, defending: 0.74 }),
      player('RVU', 4, 'Gunnar Lind', 'RCB', { pace: 31.4, passing: 0.7, shooting: 0.22, defending: 0.86 }),
      player('RVU', 5, 'Ibrahima Sow', 'LCB', { pace: 32.8, passing: 0.72, shooting: 0.2, defending: 0.84 }),
      player('RVU', 3, 'Pablo Ferrán', 'LB', { pace: 34.4, passing: 0.72, shooting: 0.26, defending: 0.7 }),
      player('RVU', 6, 'Arlo Whitcombe', 'DM', { pace: 31.5, passing: 0.8, shooting: 0.3, defending: 0.82 }),
      player('RVU', 8, 'Kenji Morita', 'RCM', { pace: 32.0, passing: 0.83, shooting: 0.45, defending: 0.7 }),
      player('RVU', 10, 'Luca Benedetti', 'AM', { pace: 32.6, passing: 0.87, shooting: 0.7, defending: 0.4 }),
      player('RVU', 7, 'Ezra Collymore', 'RW', { pace: 36.4, passing: 0.72, shooting: 0.7, defending: 0.33 }),
      player('RVU', 11, 'Faris Haddad', 'LW', { pace: 35.0, passing: 0.74, shooting: 0.65, defending: 0.36 }),
      player('RVU', 9, 'Viktor Strand', 'ST', { pace: 33.2, passing: 0.68, shooting: 0.86, defending: 0.32 }),
    ],
    bench: [
      player('RVU', 12, 'Dan Oyelaran', 'GK', { pace: 28.8, passing: 0.56, shooting: 0.05, defending: 0.68 }),
      player('RVU', 15, 'Remy Castell', 'LCB', { pace: 31.6, passing: 0.68, shooting: 0.2, defending: 0.8 }),
      player('RVU', 18, 'Oskar Nyman', 'RCM', { pace: 32.3, passing: 0.8, shooting: 0.42, defending: 0.68 }),
      player('RVU', 17, 'Tariq Bello', 'LW', { pace: 35.6, passing: 0.7, shooting: 0.66, defending: 0.3 }),
      player('RVU', 21, 'Jesse Okonkwo', 'ST', { pace: 34.2, passing: 0.64, shooting: 0.8, defending: 0.3 }),
    ],
  },
};
