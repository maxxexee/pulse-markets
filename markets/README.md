# Market specs

One JSON file per market, written by `resolver`'s `create` command. The index
service serves this directory at `/api/markets` and the markets page renders it
with a settlement preview against the published snapshot.

Each file is the fixed terms plus the id derived from them. The id is the hash of
the canonical terms, so editing a file here either creates a different market or
makes the id wrong, and the resolver refuses the second case at settlement.

The three specs committed here are examples created while there is no chain
layer: they name this index's signer and real epoch days, but nothing mints them,
so no funds are involved and the page can only preview an outcome.
