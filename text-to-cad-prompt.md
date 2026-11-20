# CAD Prompt: Dense Robotic Warehouse

Create a fully 3D warehouse layout for swarm-robot simulation.

Scene requirements:

- Rectangular warehouse floor, 84 m wide x 58 m deep, light concrete material.
- Navigation graph painted on the floor with green 1 m wide routes, aisle centerlines, and intersection nodes.
- Sixteen long double-sided rack rows arranged in eight aisle pairs.
- Each rack row has 18 bays and 3 vertical levels.
- Racks should be grey metal with uprights, crossbeams, shelves, and visible shelf clearance.
- Place cardboard boxes in most slots, with some empty slots for replenishment.
- Add white fiducial-style labels on shelf fronts and selected boxes.
- Add two outbound packing stations at the front edge and one inbound/replenishment station at the back edge.
- Add 18 compact mobile lift robots: black rounded bases, red/yellow/green lift tops, scissor-lift/fork features, and visible robot numbers.
- Show some robots carrying boxes, some parked, and some aligned inside aisles.
- Add colored route lines from robots to pick slots and stations.
- Keep geometry modular so rack rows, robots, boxes, and stations can be exported as separate parts.

Export goals:

- Primary: GLB for web preview.
- Secondary: STEP or 3MF for CAD inspection.
- Robotics handoff: SDF world or URDF assets for robot bodies and warehouse obstacles.

Scale and collision:

- Use meters.
- Rack row length: 72 m.
- Rack height: 4.4 m.
- Aisle width: 3.5 m.
- Robot footprint: about 1.7 m x 1.5 m.
- Box footprint: about 1.45 m x 0.94 m x 0.78 m.

Modeling style:

- Use simple manufacturable primitives.
- Avoid tiny decorative details that make simulation collision meshes heavy.
- Keep collision-ready versions of racks, boxes, and robots as low-poly boxes/cylinders.
