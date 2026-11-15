# Extended power-up roster

New catalog/inventory IDs: `max-healer` (type `healmax`, 450 SKR / 0.02 SOL), `health-healer` (`heal2`, 450 / 0.01), `rapid-shooter` (`rapid`, 450 / 0.01), and `rapid-shooter-long` (`rapidlong`, 900 / 0.02).

Max Healer restores the tank to maximum HP; +2 Health restores up to two HP without overhealing. The shooter variants multiply firing rate by four for 10 and 60 simulation seconds. Gameplay effects execute in the Unity simulation; the API authorizes inventory consumption and issues ordinary drops.

Catalog rewards, SOL prices, SKR defaults, inventory normalization, loadout saves, purchase grants, authenticated/idempotent consumption and Unity replay event validation recognize these IDs. Inventory is JSON, so no database migration is needed. Existing administrator price overrides retain priority.

`POST /api/economy/drops/roll` accepts `powerupRosterVersion: 1` for the expanded twelve-type ordinary pool. Omitted/zero versions preserve the eight-type pool for older clients; unsupported versions return 400. The Unity client's request and replay configuration carry version 1. No BATC reward probability, settlement or claim policy changed.

The MagicBlock contract/verified decoder remains on its existing eight outcomes; this update does not claim new VRF contract outcomes. Source changes are not a live deployment. Coordinate rollout with the matching Unity runtime, artwork pack, and multiplayer protocol `battlecities-11`.

Wipeout now removes one health from enemy NPCs in the matching Unity runtime. Replay config `wipeoutDamageVersion` accepts 0 (archived instant-kill rule) or 1 (one-damage rule); unsupported versions are rejected. Item identity, stock consumption and prices are unchanged.
