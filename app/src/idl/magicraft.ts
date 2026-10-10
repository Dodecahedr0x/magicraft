/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/magicraft.json`.
 */
export type Magicraft = {
  "address": "4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9",
  "metadata": {
    "name": "magicraft",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Magicraft: onchain voxel survival on MagicBlock Ephemeral Rollups"
  },
  "instructions": [
    {
      "name": "armChunk",
      "docs": [
        "Re-arms a chunk's tick crank if it has fluid work or mobs and the crank is stale",
        "(permissionless watchdog; chunk read-only)."
      ],
      "discriminator": [
        38,
        246,
        144,
        174,
        222,
        222,
        212,
        75
      ],
      "accounts": [
        {
          "name": "world",
          "docs": [
            "Read-only: chain time, tick interval."
          ]
        },
        {
          "name": "chunk",
          "docs": [
            "(signs with its seeds). Writable: a stale re-arm rotates the task id epoch."
          ],
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "attackMob",
      "docs": [
        "Attacks the mob in slot `idx` of `chunk` (drops to inventory on death)."
      ],
      "discriminator": [
        155,
        28,
        101,
        126,
        135,
        39,
        14,
        113
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player"
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "Read-only: seed (drops), params, chain time."
          ]
        },
        {
          "name": "playerState",
          "writable": true
        },
        {
          "name": "chunk",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "idx",
          "type": "u8"
        }
      ]
    },
    {
      "name": "breakBlock",
      "docs": [
        "Breaks a block within reach (cooldown = break time; drop to inventory, fluid enqueue)."
      ],
      "discriminator": [
        145,
        84,
        205,
        226,
        153,
        236,
        169,
        121
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Read-only; tied to `player_state` (see the module docs)."
          ]
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "Read-only: params, chain time."
          ]
        },
        {
          "name": "playerState",
          "writable": true
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "chunkN",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkS",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkE",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkW",
          "writable": true,
          "optional": true
        },
        {
          "name": "magicProgram",
          "docs": [
            "Arms the tick crank of edited chunks with fluid work (stale-gated)."
          ],
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "x",
          "type": "i32"
        },
        {
          "name": "y",
          "type": "i32"
        },
        {
          "name": "z",
          "type": "i32"
        }
      ]
    },
    {
      "name": "callbackSeed",
      "docs": [
        "VRF callback: stores the seed once."
      ],
      "discriminator": [
        179,
        172,
        236,
        94,
        46,
        130,
        64,
        92
      ],
      "accounts": [
        {
          "name": "vrfProgramIdentity",
          "docs": [
            "Scoped VRF identity PDA, bound to this program. Its presence as a signer proves",
            "the callback was issued by the VRF program for this program."
          ],
          "signer": true
        },
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "world.creator",
                "account": "world"
              },
              {
                "kind": "account",
                "path": "world.nonce",
                "account": "world"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "randomness",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "closeChunk",
      "docs": [
        "Closes an unedited, empty chunk + presence; refunds the payer Player."
      ],
      "discriminator": [
        150,
        183,
        213,
        198,
        0,
        74,
        14,
        170
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "The chunk's payer; receives the refund. `mut` ⇒ must be delegated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "writable": true
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "presence",
          "writable": true
        },
        {
          "name": "chunkN"
        },
        {
          "name": "chunkS"
        },
        {
          "name": "chunkE"
        },
        {
          "name": "chunkW"
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cx",
          "type": "i32"
        },
        {
          "name": "cz",
          "type": "i32"
        }
      ]
    },
    {
      "name": "craft",
      "docs": [
        "Crafts a recipe; stations are claimed by block position (+ chunk) and verified."
      ],
      "discriminator": [
        161,
        233,
        177,
        214,
        243,
        109,
        161,
        224
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player"
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world"
        },
        {
          "name": "playerState",
          "writable": true
        },
        {
          "name": "tableChunk",
          "optional": true
        },
        {
          "name": "furnaceChunk",
          "optional": true
        }
      ],
      "args": [
        {
          "name": "recipeId",
          "type": "u16"
        },
        {
          "name": "count",
          "type": "u8"
        },
        {
          "name": "table",
          "type": {
            "option": {
              "array": [
                "i32",
                3
              ]
            }
          }
        },
        {
          "name": "furnace",
          "type": {
            "option": {
              "array": [
                "i32",
                3
              ]
            }
          }
        }
      ]
    },
    {
      "name": "createChunk",
      "docs": [
        "Creates `Chunk (cx, cz)` (10 240 B, `gen_stage 0`) + its empty presence list,",
        "sponsored by the Player. Same tx: `grow_chunk`."
      ],
      "discriminator": [
        83,
        226,
        15,
        219,
        9,
        19,
        186,
        90
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority (fee payer; ER fees are 0)."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Sponsor (pays the ephemeral rent). `mut` ⇒ delegated on the ER."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "`chunk_count` is updated; the seed must be set."
          ],
          "writable": true
        },
        {
          "name": "chunk",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  104,
                  117,
                  110,
                  107
                ]
              },
              {
                "kind": "account",
                "path": "world"
              },
              {
                "kind": "arg",
                "path": "cx"
              },
              {
                "kind": "arg",
                "path": "cz"
              }
            ]
          }
        },
        {
          "name": "presence",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  101,
                  115,
                  101,
                  110,
                  99,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "chunk"
              }
            ]
          }
        },
        {
          "name": "chunkN",
          "docs": [
            "(`check_slots`)."
          ]
        },
        {
          "name": "chunkS"
        },
        {
          "name": "chunkE"
        },
        {
          "name": "chunkW"
        },
        {
          "name": "playerState",
          "docs": [
            "The signing player's `PlayerState` in `world` (identity checked in the handler):",
            "allows creating the chunk the player currently stands in, see `check_adjacency`."
          ],
          "optional": true
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cx",
          "type": "i32"
        },
        {
          "name": "cz",
          "type": "i32"
        }
      ]
    },
    {
      "name": "createWorld",
      "docs": [
        "Creates the ephemeral World (sponsored by the Player) and arms its day crank;",
        "`us_per_slot_hint`: the client-measured ER slot rate (0 = default 50 ms)."
      ],
      "discriminator": [
        117,
        96,
        81,
        112,
        15,
        209,
        71,
        63
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key (also the tx fee payer on the ER; fees are 0)."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Sponsor: pays the World's ephemeral rent. Delegated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  111,
                  114,
                  108,
                  100
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "name",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "params",
          "type": {
            "defined": {
              "name": "worldParams"
            }
          }
        },
        {
          "name": "usPerSlotHint",
          "type": "u32"
        }
      ]
    },
    {
      "name": "debugCancelTick",
      "docs": [
        "Test hook (`localnet` builds only): cancels a chunk's tick task, header untouched."
      ],
      "discriminator": [
        150,
        31,
        184,
        114,
        232,
        246,
        102,
        133
      ],
      "accounts": [
        {
          "name": "world"
        },
        {
          "name": "chunk"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "debugSpawnMob",
      "docs": [
        "Test hook (`localnet` builds only): puts a mob of `kind` (full hp) at the FP feet",
        "position `pos` into a free slot of the chunk holding it, and arms its crank;",
        "`kind == 0` clears the chunk's mob slots."
      ],
      "discriminator": [
        70,
        97,
        44,
        112,
        54,
        254,
        44,
        181
      ],
      "accounts": [
        {
          "name": "world"
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "kind",
          "type": "u8"
        },
        {
          "name": "pos",
          "type": {
            "array": [
              "i32",
              3
            ]
          }
        }
      ]
    },
    {
      "name": "delegatePlayer",
      "discriminator": [
        235,
        159,
        245,
        102,
        161,
        199,
        254,
        89
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "bufferPlayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                48,
                137,
                70,
                76,
                148,
                75,
                16,
                66,
                104,
                222,
                201,
                224,
                1,
                24,
                131,
                245,
                94,
                181,
                167,
                141,
                195,
                41,
                59,
                86,
                137,
                187,
                240,
                221,
                49,
                242,
                105,
                234
              ]
            }
          }
        },
        {
          "name": "delegationRecordPlayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "player"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "delegationMetadataPlayer",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  105,
                  111,
                  110,
                  45,
                  109,
                  101,
                  116,
                  97,
                  100,
                  97,
                  116,
                  97
                ]
              },
              {
                "kind": "account",
                "path": "player"
              }
            ],
            "program": {
              "kind": "account",
              "path": "delegationProgram"
            }
          }
        },
        {
          "name": "player",
          "docs": [
            "CPI re-derives it from the same seeds). Untyped because ownership moves",
            "to the delegation program during the CPI."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "ownerProgram",
          "address": "4GTybm3WD66wUnTgS8UcB9H947uAY7BAqivp8HfbSsW9"
        },
        {
          "name": "delegationProgram",
          "address": "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "validator",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "deposit",
      "discriminator": [
        242,
        35,
        198,
        137,
        82,
        225,
        242,
        182
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "player"
          ]
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    },
    {
      "name": "eat",
      "docs": [
        "Eats the food in `slot`."
      ],
      "discriminator": [
        119,
        204,
        245,
        70,
        84,
        134,
        55,
        200
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player"
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "playerState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "slot",
          "type": "u8"
        }
      ]
    },
    {
      "name": "growChunk",
      "docs": [
        "Resizes the chunk to full size and writes stage-1 terrain (`gen_stage 1`).",
        "Permissionless (sponsor = the chunk's payer Player)."
      ],
      "discriminator": [
        40,
        249,
        220,
        157,
        76,
        36,
        129,
        127
      ],
      "accounts": [
        {
          "name": "player",
          "docs": [
            "The chunk's payer (`chunk.payer`, checked): sponsors the resize, signing with its",
            "stored PDA seeds. No user signature: the rent was reserved at `create_chunk`."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "world"
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cx",
          "type": "i32"
        },
        {
          "name": "cz",
          "type": "i32"
        }
      ]
    },
    {
      "name": "initPlayer",
      "discriminator": [
        114,
        27,
        219,
        144,
        50,
        15,
        228,
        66
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "joinWorld",
      "docs": [
        "Creates the player's `PlayerState` in the world at the spawn (sponsored by the Player)."
      ],
      "discriminator": [
        87,
        218,
        18,
        183,
        222,
        75,
        18,
        123
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Sponsor of the PlayerState rent. `mut` ⇒ delegated on the ER."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "The spawn must be set; mut: the first join records `first_join_ms` (freezes the",
            "clock's backward correction)."
          ],
          "writable": true
        },
        {
          "name": "playerState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "world"
              },
              {
                "kind": "account",
                "path": "player"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "movePlayer",
      "docs": [
        "Validates and applies one movement update (presence, damage, hunger). World read-only."
      ],
      "discriminator": [
        17,
        58,
        68,
        221,
        186,
        117,
        140,
        231
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Presence rent sponsor (grow: pays, shrink/prune: refunded). `mut` ⇒ delegated."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "Read-only: chain time and params. Never written (no write lock between movers)."
          ]
        },
        {
          "name": "playerState",
          "docs": [
            "The mover's state in `world` (stored identity checked instead of a PDA derivation:",
            "only `join_world` writes these fields, at the PDA of the pair it stores)."
          ],
          "writable": true
        },
        {
          "name": "chunk00",
          "optional": true
        },
        {
          "name": "chunk10",
          "optional": true
        },
        {
          "name": "chunk01",
          "optional": true
        },
        {
          "name": "chunk11",
          "optional": true
        },
        {
          "name": "presence",
          "writable": true
        },
        {
          "name": "oldPresence",
          "docs": [
            "chunk (`presence_of`; `InvalidPresence` if missing or of another chunk)."
          ],
          "writable": true,
          "optional": true
        },
        {
          "name": "vault",
          "writable": true,
          "address": "MagicVau1t999999999999999999999999999999999"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "pos",
          "type": {
            "array": [
              "i32",
              3
            ]
          }
        },
        {
          "name": "vel",
          "type": {
            "array": [
              "i32",
              3
            ]
          }
        },
        {
          "name": "onGround",
          "type": "bool"
        },
        {
          "name": "clientMs",
          "type": "i64"
        }
      ]
    },
    {
      "name": "ping",
      "discriminator": [
        173,
        0,
        94,
        236,
        73,
        133,
        225,
        153
      ],
      "accounts": [],
      "args": []
    },
    {
      "name": "placeBlock",
      "docs": [
        "Places the block item of `slot` at a free, face-adjacent position within reach.",
        "`remaining_accounts`: neighbour presence lists for border blocks (see `actions`)."
      ],
      "discriminator": [
        184,
        154,
        18,
        192,
        205,
        185,
        38,
        139
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "Read-only; tied to `player_state`."
          ]
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world"
        },
        {
          "name": "playerState",
          "writable": true
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "presence"
        },
        {
          "name": "chunkN",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkS",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkE",
          "writable": true,
          "optional": true
        },
        {
          "name": "chunkW",
          "writable": true,
          "optional": true
        },
        {
          "name": "magicProgram",
          "docs": [
            "Arms the tick crank of edited chunks with fluid work (stale-gated)."
          ],
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "x",
          "type": "i32"
        },
        {
          "name": "y",
          "type": "i32"
        },
        {
          "name": "z",
          "type": "i32"
        },
        {
          "name": "slot",
          "type": "u8"
        }
      ]
    },
    {
      "name": "populateChunk",
      "docs": [
        "Stage 2 (caves, ores, trees, animals). Permissionless; World read-only."
      ],
      "discriminator": [
        49,
        153,
        174,
        172,
        253,
        180,
        110,
        215
      ],
      "accounts": [
        {
          "name": "world",
          "docs": [
            "Read-only (the spawn is set by `set_spawn`)."
          ]
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "magicProgram",
          "docs": [
            "Arms the tick crank when animals were placed."
          ],
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "cx",
          "type": "i32"
        },
        {
          "name": "cz",
          "type": "i32"
        }
      ]
    },
    {
      "name": "processUndelegation",
      "discriminator": [
        196,
        28,
        41,
        206,
        48,
        37,
        51,
        167
      ],
      "accounts": [
        {
          "name": "baseAccount",
          "writable": true
        },
        {
          "name": "buffer",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  117,
                  110,
                  100,
                  101,
                  108,
                  101,
                  103,
                  97,
                  116,
                  101,
                  45,
                  98,
                  117,
                  102,
                  102,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "baseAccount"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                181,
                183,
                0,
                225,
                242,
                87,
                58,
                192,
                204,
                6,
                34,
                1,
                52,
                74,
                207,
                151,
                184,
                53,
                6,
                235,
                140,
                229,
                25,
                152,
                204,
                98,
                126,
                24,
                147,
                128,
                167,
                62
              ]
            }
          }
        },
        {
          "name": "payer",
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "accountSeeds",
          "type": {
            "vec": "bytes"
          }
        }
      ]
    },
    {
      "name": "requestSeed",
      "docs": [
        "Requests the world seed from the ER VRF queue (the creator's Player PDA pays)."
      ],
      "discriminator": [
        162,
        96,
        174,
        50,
        178,
        77,
        115,
        152
      ],
      "accounts": [
        {
          "name": "signer",
          "docs": [
            "Wallet or session key of `player`'s authority (any player, not only the creator:",
            "the VRF output is unbiasable, so who pays does not matter)."
          ],
          "signer": true
        },
        {
          "name": "player",
          "docs": [
            "A delegated Player: the VRF payer (signs via its seeds; mut ⇒ delegated on the ER)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "player.authority",
                "account": "player"
              }
            ]
          }
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world"
        },
        {
          "name": "oracleQueue",
          "writable": true,
          "address": "Sc9MJUngNbQXSXGP3F67KvKwVnhaYn6kcioxXNVowYT"
        },
        {
          "name": "programIdentity",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  105,
                  100,
                  101,
                  110,
                  116,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "vrfProgram",
          "address": "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz"
        },
        {
          "name": "slotHashes",
          "address": "SysvarS1otHashes111111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "clientSeed",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "respawn",
      "docs": [
        "Dead player only: back to the spawn with an empty inventory."
      ],
      "discriminator": [
        21,
        232,
        156,
        94,
        79,
        43,
        204,
        41
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player"
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "world",
          "docs": [
            "Read-only: spawn, chain time."
          ]
        },
        {
          "name": "playerState",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "scheduleDayCrank",
      "docs": [
        "(Re)arms the World's day crank (permissionless, idempotent)."
      ],
      "discriminator": [
        246,
        255,
        236,
        80,
        105,
        186,
        201,
        111
      ],
      "accounts": [
        {
          "name": "world",
          "docs": [
            "Task authority (signs the Magic-program CPI with its PDA seeds). Writable: a re-arm",
            "rotates the task id epoch (only when stale, so the write lock is rare)."
          ],
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "selectSlot",
      "docs": [
        "Selects the held inventory slot."
      ],
      "discriminator": [
        168,
        97,
        52,
        1,
        78,
        162,
        190,
        62
      ],
      "accounts": [
        {
          "name": "signer",
          "signer": true
        },
        {
          "name": "player"
        },
        {
          "name": "sessionToken",
          "optional": true
        },
        {
          "name": "playerState",
          "writable": true
        }
      ],
      "args": [
        {
          "name": "slot",
          "type": "u8"
        }
      ]
    },
    {
      "name": "setSpawn",
      "docs": [
        "Sets the world spawn once from the populated chunk (0,0). Permissionless."
      ],
      "discriminator": [
        182,
        95,
        41,
        77,
        120,
        150,
        0,
        164
      ],
      "accounts": [
        {
          "name": "world",
          "writable": true
        },
        {
          "name": "chunk"
        }
      ],
      "args": []
    },
    {
      "name": "tickChunk",
      "docs": [
        "Crank target: one chunk tick (fluid, mobs, zombie spawn, idle / renewal).",
        "Permissionless; never fails on recoverable state."
      ],
      "discriminator": [
        59,
        67,
        116,
        92,
        234,
        65,
        217,
        101
      ],
      "accounts": [
        {
          "name": "world",
          "docs": [
            "Read-only: chain time, params, seed, time of day."
          ]
        },
        {
          "name": "chunk",
          "writable": true
        },
        {
          "name": "presence",
          "writable": true
        },
        {
          "name": "chunkN",
          "writable": true
        },
        {
          "name": "chunkS",
          "writable": true
        },
        {
          "name": "chunkE",
          "writable": true
        },
        {
          "name": "chunkW",
          "writable": true
        },
        {
          "name": "presenceN",
          "writable": true
        },
        {
          "name": "presenceS",
          "writable": true
        },
        {
          "name": "presenceE",
          "writable": true
        },
        {
          "name": "presenceW",
          "writable": true
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "tickDay",
      "docs": [
        "Crank target: re-anchors the clock and advances `time_of_day_ms`."
      ],
      "discriminator": [
        10,
        240,
        80,
        137,
        178,
        4,
        113,
        2
      ],
      "accounts": [
        {
          "name": "world",
          "docs": [
            "No signer: cranked txs are signed by the validator; any World is fine to tick",
            "(owner + discriminator checked by `Account`)."
          ],
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "withdraw",
      "docs": [
        "ER: commit + undelegate the Player (step 1 of a withdrawal)."
      ],
      "discriminator": [
        183,
        18,
        70,
        156,
        148,
        109,
        161,
        34
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "player"
          ]
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        },
        {
          "name": "magicContext",
          "writable": true,
          "address": "MagicContext1111111111111111111111111111111"
        },
        {
          "name": "magicProgram",
          "address": "Magic11111111111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawBase",
      "docs": [
        "Base layer, after undelegation: transfer `lamports` to the wallet."
      ],
      "discriminator": [
        161,
        122,
        255,
        170,
        42,
        39,
        23,
        120
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true,
          "relations": [
            "player"
          ]
        },
        {
          "name": "player",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  108,
                  97,
                  121,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "authority"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "lamports",
          "type": "u64"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "player",
      "discriminator": [
        205,
        222,
        112,
        7,
        165,
        155,
        206,
        218
      ]
    },
    {
      "name": "playerState",
      "discriminator": [
        56,
        3,
        60,
        86,
        174,
        16,
        244,
        195
      ]
    },
    {
      "name": "world",
      "discriminator": [
        145,
        45,
        170,
        174,
        122,
        32,
        155,
        124
      ]
    }
  ],
  "errors": [
    {
      "code": 6100,
      "name": "unauthorized",
      "msg": "Signer is neither the player authority nor a valid session key"
    },
    {
      "code": 6101,
      "name": "invalidChunk",
      "msg": "Account is not a valid chunk for this world"
    },
    {
      "code": 6102,
      "name": "invalidPresence",
      "msg": "Account is not a valid chunk presence list"
    },
    {
      "code": 6103,
      "name": "chunkNotReady",
      "msg": "Chunk is not generated yet"
    },
    {
      "code": 6104,
      "name": "insufficientSponsorFunds",
      "msg": "Player does not have enough lamports to sponsor this account"
    },
    {
      "code": 6105,
      "name": "insufficientFunds",
      "msg": "Withdrawal would leave the Player below its rent-exempt minimum"
    },
    {
      "code": 6106,
      "name": "overflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6107,
      "name": "invalidParams",
      "msg": "World params out of range"
    },
    {
      "code": 6108,
      "name": "seedPending",
      "msg": "World seed is not set yet (VRF pending)"
    },
    {
      "code": 6109,
      "name": "seedAlreadySet",
      "msg": "World seed is already set"
    },
    {
      "code": 6110,
      "name": "notAdjacent",
      "msg": "Chunk must be adjacent to an existing chunk or the player's chunk"
    },
    {
      "code": 6111,
      "name": "wrongGenStage",
      "msg": "Chunk generation stage does not allow this"
    },
    {
      "code": 6112,
      "name": "chunkEdited",
      "msg": "Chunk was edited and cannot be closed"
    },
    {
      "code": 6113,
      "name": "chunkHasMobs",
      "msg": "Chunk still has mobs"
    },
    {
      "code": 6114,
      "name": "chunkOccupied",
      "msg": "Chunk still has players present"
    },
    {
      "code": 6115,
      "name": "moveTooFast",
      "msg": "Move too fast"
    },
    {
      "code": 6116,
      "name": "collision",
      "msg": "Move collides with a solid block"
    },
    {
      "code": 6117,
      "name": "notOnGround",
      "msg": "Claimed on_ground without ground"
    },
    {
      "code": 6118,
      "name": "flying",
      "msg": "Rose higher than jumping allows"
    },
    {
      "code": 6119,
      "name": "invalidMoveState",
      "msg": "Invalid movement state or coordinates"
    },
    {
      "code": 6120,
      "name": "timeSkew",
      "msg": "Client time out of range of chain time"
    },
    {
      "code": 6121,
      "name": "outOfReach",
      "msg": "Target out of reach"
    },
    {
      "code": 6122,
      "name": "cooldown",
      "msg": "Action on cooldown"
    },
    {
      "code": 6123,
      "name": "unbreakable",
      "msg": "Block cannot be broken"
    },
    {
      "code": 6124,
      "name": "invalidTarget",
      "msg": "Target block is not replaceable"
    },
    {
      "code": 6125,
      "name": "notFaceAdjacent",
      "msg": "Placed block must touch a solid face"
    },
    {
      "code": 6126,
      "name": "selfOverlap",
      "msg": "Placed block overlaps a player"
    },
    {
      "code": 6127,
      "name": "notPlaceable",
      "msg": "Item cannot be placed"
    },
    {
      "code": 6128,
      "name": "dead",
      "msg": "Player is dead"
    },
    {
      "code": 6129,
      "name": "notDead",
      "msg": "Player is not dead"
    },
    {
      "code": 6130,
      "name": "noMob",
      "msg": "No mob in that slot"
    },
    {
      "code": 6131,
      "name": "badSlot",
      "msg": "Invalid inventory slot"
    },
    {
      "code": 6132,
      "name": "emptySlot",
      "msg": "Inventory slot is empty"
    },
    {
      "code": 6133,
      "name": "notEnoughItems",
      "msg": "Not enough items"
    },
    {
      "code": 6134,
      "name": "invalidCount",
      "msg": "Invalid count"
    },
    {
      "code": 6135,
      "name": "notFood",
      "msg": "Item is not food"
    },
    {
      "code": 6136,
      "name": "foodFull",
      "msg": "Food is full"
    },
    {
      "code": 6137,
      "name": "inventoryFull",
      "msg": "Inventory full"
    },
    {
      "code": 6138,
      "name": "unknownRecipe",
      "msg": "Unknown recipe"
    },
    {
      "code": 6139,
      "name": "wrongStation",
      "msg": "Required station not within reach"
    },
    {
      "code": 6140,
      "name": "missingInputs",
      "msg": "Missing recipe inputs"
    },
    {
      "code": 6141,
      "name": "missingFuel",
      "msg": "Missing furnace fuel"
    },
    {
      "code": 6142,
      "name": "spawnAlreadySet",
      "msg": "World spawn is already set"
    },
    {
      "code": 6143,
      "name": "spawnNotSet",
      "msg": "World spawn is not set yet"
    },
    {
      "code": 6144,
      "name": "spawnChunk",
      "msg": "The spawn chunk (0, 0) cannot be closed"
    }
  ],
  "types": [
    {
      "name": "player",
      "docs": [
        "Per-wallet account. Holds the SOL that sponsors every ephemeral account the",
        "player creates. Created, funded and delegated on the base layer."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "openChunks",
            "docs": [
              "Chunks this Player sponsors that are still open (`create_chunk` +1,",
              "`close_chunk` −1). UI warnings only: `withdraw` is never blocked by it."
            ],
            "type": "u32"
          },
          {
            "name": "reserved",
            "docs": [
              "Padding for future fields (keeps the account size stable)."
            ],
            "type": {
              "array": [
                "u8",
                60
              ]
            }
          }
        ]
      }
    },
    {
      "name": "playerState",
      "docs": [
        "A player's state inside one world. Ephemeral."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "player",
            "docs": [
              "The Player PDA."
            ],
            "type": "pubkey"
          },
          {
            "name": "world",
            "type": "pubkey"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "moveState",
            "docs": [
              "`core::physics::MoveState` bytes."
            ],
            "type": {
              "array": [
                "u8",
                72
              ]
            }
          },
          {
            "name": "health",
            "type": "u8"
          },
          {
            "name": "food",
            "type": "u8"
          },
          {
            "name": "exhaustion",
            "docs": [
              "Food exhaustion accumulator (hunger drains one food point per threshold)."
            ],
            "type": "u16"
          },
          {
            "name": "inventory",
            "docs": [
              "`core::inventory::Inventory` bytes."
            ],
            "type": {
              "array": [
                "u8",
                216
              ]
            }
          },
          {
            "name": "heldSlot",
            "type": "u8"
          },
          {
            "name": "cx",
            "docs": [
              "Current chunk."
            ],
            "type": "i32"
          },
          {
            "name": "cz",
            "type": "i32"
          },
          {
            "name": "breakUntilMs",
            "type": "i64"
          },
          {
            "name": "attackUntilMs",
            "type": "i64"
          },
          {
            "name": "foodTickMs",
            "docs": [
              "Last hunger / regeneration step, chain ms."
            ],
            "type": "i64"
          },
          {
            "name": "respawnMs",
            "docs": [
              "Chain ms of the last `respawn` (0 = never). Pending damage on an own presence entry",
              "last seen before it hit the dead body and is dropped (`presence::upsert`)."
            ],
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                26
              ]
            }
          }
        ]
      }
    },
    {
      "name": "sessionTokenV2",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          },
          {
            "name": "targetProgram",
            "type": "pubkey"
          },
          {
            "name": "sessionSigner",
            "type": "pubkey"
          },
          {
            "name": "feePayer",
            "type": "pubkey"
          },
          {
            "name": "validUntil",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "timeAnchor",
      "docs": [
        "Chain time with ms resolution (`Clock::unix_timestamp` has 1 s): `chain_ms = anchor_ms +",
        "⌊(slot − anchor_slot) · us_per_slot / 1000⌋`.",
        "",
        "- **Readers** (gameplay ixs) call [`Self::read`] on a read-only World: never writes.",
        "- **The writer** is `tick_day` (every ~1 s) plus the initial anchor in `create_world`",
        "(rate = the client's measured hint, clamped, or [`DEFAULT_US_PER_SLOT`]); only it calls",
        "[`Self::reanchor`].",
        "- Rate: `base_us_per_slot` is measured from wall time since the sync point",
        "(`sync_slot` / `sync_ms`). Before [`RATE_SPAN_MS`] every re-anchor checks the current",
        "rate against the observed span (known to ±1 000 ms: `unix_timestamp` has 1 s",
        "resolution) and replaces it by the measurement only when they are inconsistent, so",
        "a good client hint is kept and a wrong one is replaced within a tick or two. Over",
        "every [`RATE_SPAN_MS`] the measurement is adopted and the sync point moves.",
        "- Offset, **after the first join** (`allow_back == false`): monotonic — the new anchor",
        "is never below the estimate readers saw at that slot, so fine readings never go",
        "backwards. Lagging by > [`REANCHOR_DRIFT_MS`] → jump forward to wall time; lagging",
        "by more than [`RATE_DEADBAND_MS`] → run 1/8 fast; ahead by more than the deadband →",
        "hold continuity and run 1/8 slow until wall time catches up (slew, never back).",
        "- Offset, **before the first join** (`allow_back == true`, `World.first_join_ms == 0`:",
        "no `PlayerState` holds a stamp from this clock yet): off by more than the deadband",
        "in either direction → step to wall time, so a wrong initial rate is repaired within",
        "a tick instead of slewing for minutes. The first `join_world` re-anchors this way",
        "once more right before it stamps the new `PlayerState`.",
        "- `us_per_slot` is the effective (slewed) rate readers use.",
        "",
        "All-zero (`us_per_slot == 0`) = not anchored yet."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "anchorSlot",
            "type": "u64"
          },
          {
            "name": "anchorMs",
            "type": "i64"
          },
          {
            "name": "usPerSlot",
            "docs": [
              "Effective rate (base ± slew), µs per slot."
            ],
            "type": "u32"
          },
          {
            "name": "baseUsPerSlot",
            "docs": [
              "Measured rate, µs per slot."
            ],
            "type": "u32"
          },
          {
            "name": "syncSlot",
            "docs": [
              "Start of the current rate measurement: slot and wall ms."
            ],
            "type": "u64"
          },
          {
            "name": "syncMs",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "world",
      "docs": [
        "A world. Ephemeral, ≤ 10 240 bytes so `create_world` needs one ix."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "creator",
            "docs": [
              "Wallet that created the world (`Player.authority`; seeds use it)."
            ],
            "type": "pubkey"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "name",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "params",
            "type": {
              "defined": {
                "name": "worldParams"
              }
            }
          },
          {
            "name": "seed",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "seedSet",
            "type": "bool"
          },
          {
            "name": "spawn",
            "docs": [
              "**Block** coordinates (not fixed-point) of the spawn feet block, set once by",
              "`set_spawn` from chunk (0,0). `join_world` / `respawn` convert to the FP feet",
              "position: `x·256 + 128, y·256, z·256 + 128` (block center)."
            ],
            "type": {
              "array": [
                "i32",
                3
              ]
            }
          },
          {
            "name": "spawnSet",
            "type": "bool"
          },
          {
            "name": "timeOfDayMs",
            "type": "u64"
          },
          {
            "name": "dayTaskId",
            "type": "i64"
          },
          {
            "name": "lastTickMs",
            "type": "i64"
          },
          {
            "name": "chunkCount",
            "type": "u32"
          },
          {
            "name": "clock",
            "type": {
              "defined": {
                "name": "timeAnchor"
              }
            }
          },
          {
            "name": "dayTicks",
            "docs": [
              "Wrapping count of `tick_day` executions (diagnostics: crank liveness / rate)."
            ],
            "type": "u32"
          },
          {
            "name": "dayEpoch",
            "docs": [
              "Epoch mixed into the day crank's task id (`scheduler::task_id`); a stale re-arm",
              "bumps it, so a squatted id is abandoned."
            ],
            "type": "u8"
          },
          {
            "name": "firstJoinMs",
            "docs": [
              "Chain ms of the first `join_world` (0 = nobody joined yet). Until then the day crank",
              "may step the clock backward (see [`TimeAnchor`]); afterwards it is monotonic."
            ],
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                9
              ]
            }
          }
        ]
      }
    },
    {
      "name": "worldParams",
      "docs": [
        "Anchor/IDL mirror of `magicraft_core::physics::WorldParams`. Same fields in the",
        "same order, so its Borsh bytes equal the core `to_bytes` layout (48 B)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "walkSpeed",
            "type": "u32"
          },
          {
            "name": "sprintSpeed",
            "type": "u32"
          },
          {
            "name": "swimSpeed",
            "type": "u32"
          },
          {
            "name": "jumpVelocity",
            "type": "u32"
          },
          {
            "name": "gravity",
            "type": "u32"
          },
          {
            "name": "maxFallSpeed",
            "type": "u32"
          },
          {
            "name": "reach",
            "type": "u32"
          },
          {
            "name": "attackCooldownMs",
            "type": "u32"
          },
          {
            "name": "dayLengthSecs",
            "type": "u32"
          },
          {
            "name": "mobTickMs",
            "type": "u32"
          },
          {
            "name": "fluidTickMs",
            "type": "u32"
          },
          {
            "name": "fallDamage",
            "type": "u8"
          },
          {
            "name": "hunger",
            "type": "u8"
          },
          {
            "name": "zombieCapPerChunk",
            "type": "u8"
          },
          {
            "name": "pad",
            "docs": [
              "Must be 0 (`validate` rejects anything else)."
            ],
            "type": "u8"
          }
        ]
      }
    }
  ]
};
