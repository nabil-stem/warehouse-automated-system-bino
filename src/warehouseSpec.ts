export type Slot = {
  id: string;
  x: number;
  z: number;
  level: number;
  shelfSide: -1 | 1;
  sku: string;
  occupied: boolean;
  demand: number;
};

export type Mission = {
  id: string;
  robotId: number;
  sku: string;
  from: string;
  to: "PACK_A" | "PACK_B" | "REPLENISH";
  status: "queued" | "moving" | "lifting" | "placing" | "done";
};

export type RobotSpec = {
  id: number;
  home: { x: number; z: number };
  color: string;
  missionId: string;
  phaseOffset: number;
};

export const warehouse = {
  footprint: { width: 84, depth: 58 },
  aisles: 8,
  rackRows: 16,
  baysPerRow: 18,
  levels: 3,
  bayPitch: 4,
  rowPitch: 6,
  mainAisleZ: -24,
  packingStations: [
    { id: "PACK_A", label: "Pack A", x: -34, z: -25 },
    { id: "PACK_B", label: "Pack B", x: 34, z: -25 },
    { id: "REPLENISH", label: "Inbound", x: 0, z: 25 }
  ]
} as const;

const skus = ["A14", "B22", "C05", "D73", "E18", "F41", "G09", "H66", "J31"];

export const slots: Slot[] = Array.from({ length: warehouse.rackRows }).flatMap((_, row) => {
  const pair = Math.floor(row / 2);
  const side: -1 | 1 = row % 2 === 0 ? -1 : 1;
  const z = -17 + pair * warehouse.rowPitch + side * 1.25;
  return Array.from({ length: warehouse.baysPerRow }).flatMap((__, bay) => {
    const x = -34 + bay * warehouse.bayPitch;
    return Array.from({ length: warehouse.levels }).map((___, level) => {
      const ordinal = row * warehouse.baysPerRow * warehouse.levels + bay * warehouse.levels + level;
      return {
        id: `R${String(row + 1).padStart(2, "0")}-B${String(bay + 1).padStart(2, "0")}-L${level + 1}`,
        x,
        z,
        level,
        shelfSide: side,
        sku: skus[(ordinal + row + bay) % skus.length],
        occupied: (ordinal + bay) % 5 !== 0,
        demand: ((ordinal * 7) % 11) + 1
      };
    });
  });
});

export const robots: RobotSpec[] = Array.from({ length: 18 }).map((_, index) => ({
  id: index + 1,
  home: { x: -38 + (index % 9) * 9.5, z: -25 - Math.floor(index / 9) * 3.3 },
  color: index % 3 === 0 ? "#1f7ae0" : index % 3 === 1 ? "#16a4d8" : "#38d36f",
  missionId: `M-${String(index + 1).padStart(3, "0")}`,
  phaseOffset: index * 0.19
}));

export const missions: Mission[] = robots.map((robot, index) => {
  const slot = slots.filter((item) => item.occupied)[(index * 37) % slots.filter((item) => item.occupied).length];
  return {
    id: robot.missionId,
    robotId: robot.id,
    sku: slot.sku,
    from: slot.id,
    to: index % 4 === 0 ? "REPLENISH" : index % 2 === 0 ? "PACK_A" : "PACK_B",
    status: "moving"
  };
});

export const findSlot = (id: string) => slots.find((slot) => slot.id === id) ?? slots[0];
