# Testing SAS

The backend has 261 automated tests covering unit, white-box, integration, black-box and system testing. They use only Node's built-in test runner (`node:test`) and `assert`, so there is nothing extra to install.

```bash
cd backend
npm test                 # everything (261 tests)
npm run test:unit        # unit tests
npm run test:whitebox    # basis-path tests + unit tests (white-box techniques)
npm run test:integration # routes <-> services <-> database
npm run test:blackbox    # EP/BVA, decision table, state transitions
npm run test:system      # requirements + a full trading day
npm run test:coverage    # everything, with a statement/branch coverage report
```

Each test file runs in its own process against its own throwaway SQLite database (`tests/helpers.js`), so tests never touch `sas.db` and cannot affect each other.

## Levels and techniques

| Level | Folder | Tests | What it checks | Techniques |
|---|---|---|---|---|
| Unit | `tests/unit/` | 82 | Each service function in isolation (`inventory`, `transaction`, `report`) against a real temporary database | Statement and branch coverage: every `if` has a test for its true and its false side |
| White box | `tests/whitebox/` + `tests/unit/` | 9 + 82 | Internal structure of the code | Basis-path testing of `addLineItem`, statement/branch coverage, atomicity (rollback) checks |
| Integration | `tests/integration/` | 23 | Modules working together: routes, services and SQLite, with no mocks | Interface testing between transaction, inventory and report modules; database constraints; access control before services run |
| Black box | `tests/blackbox/` | 129 | The public REST API only, from the specification | Equivalence partitioning, boundary value analysis, decision table, state-transition testing |
| System | `tests/system/` | 18 | The whole running system, all three roles, through HTTP | Requirement-based scenarios (R1 to R12) and one full trading-day run with a books-balance check |

### White box: basis path testing
`addLineItem` (in `backend/services/transaction.js`) has 7 decisions once its helper validators are counted, so its cyclomatic complexity is V(G) = 7 + 1 = 8. `tests/whitebox/basis-path.test.js` runs the 8 independent paths:

| Path | Decision that decides it | Outcome |
|---|---|---|
| P0 | all pass | line added, state `adding_items` |
| P1 | transaction not open | 400 |
| P2 | item does not exist | 404 |
| P3 | quantity not a positive number | 400 |
| P4a | count item with a fractional quantity | 400 |
| P4b | weight item with more than 2 decimals | 400 |
| P5 | quantity above stock (cumulative) | 409 |
| P6 | line amount rounds to zero | 400 |

A further test checks that every rejected path leaves the database unchanged.

### Black box: what is partitioned
- **Equivalence partitioning and boundary values** (`equivalence-boundary.test.js`): quantity of a count item, weight of a weight item, item code, price change, stock supply (quantity and date), report date range, login, inventory search. Boundaries include 0 / 1 / stock / stock + 1 for quantities, 0.01 / 0.009 / 1.255 for weights, and 100000 / 100000.01 for prices and supplies. Wrong types (boolean, array, null, object, `"Infinity"`) are also tried.
- **Decision table** (`decision-table.test.js`): the four conditions for adding an item (transaction open, item exists, quantity valid, stock enough) give the rules R1 to R6, including the order in which conditions are checked.
- **State transition** (`state-transition.test.js`): every combination of the five observable states (`initiated`, `adding_items`, `bill_printed`, `completed`, `cancelled`) and the five events (add, remove, finalize, pay, cancel) is executed: 25 transitions, each checking both the HTTP status and the resulting state. The states `billed` and `inventory_updated` from the state chart happen inside one database transaction at finalize time, so they are never visible. It also checks that stock changes only at finalize.

### System tests
- `requirements.test.js`: one test per requirement of the problem statement.
- `trading-day.test.js`: stock arrives, sales are made at the old and new price, one sale is cancelled, an item is removed, and reports are checked; then the inventory and report totals are cross-checked against the stored bills.

## Requirement traceability

| Requirement (problem statement) | Requirement test | Also covered by |
|---|---|---|
| Register item type and quantity by barcode and weight | R1, R2 | equivalence-boundary (item code, weight, quantity), decision table |
| Bill with serial number, name, code, quantity, unit price, item price and total | R3, R4, R5 | unit `generateBill`, integration (bill matches stored lines) |
| Inventory decreases when an item is sold | R6, R6b | state-transition (stock only at finalize), unit `decreaseStock` |
| Manager can query inventory details | R7, R7b | equivalence-boundary (search), integration |
| Employee updates inventory when new supply arrives | R8 | equivalence-boundary (supply), unit `increaseStock`, integration |
| Sales statistics per item for a day or period: quantity, price realized, profit | R9 | unit report tests, integration (report vs bills) |
| Manager can change the selling price | R10, R10b | equivalence-boundary (price), integration |
| Customer pays the bill | R11 | state-transition (`pay`) |
| Roles are separated | R12 | integration (access control) |

## Results and coverage

All 261 tests pass. Coverage of the backend from `npm run test:coverage`:

| File | Lines | Branches | Functions |
|---|---|---|---|
| `services/inventory.js` | 100% | 100% | 100% |
| `services/transaction.js` | 100% | 100% | 100% |
| `services/report.js` | 100% | 100% | 100% |
| `routes/api.js` | 100% | 91% | 95% |
| `db.js` | 100% | 80% | 100% |
| `server.js` | 88% | 67% | 50% |
| **All files** | **99.3%** | **95.5%** | **96.6%** |

The uncovered lines in `server.js` (23-25) are the start-up code that only runs when the file is launched directly; the tests import the app instead. The uncovered branches in `routes/api.js` and `db.js` are the unexpected-error (500) handler and the "already seeded" path of the seed function.

## Defects the tests found

Writing the black-box boundary tests exposed defects in the first version, which were then fixed:

| Defect | Fix |
|---|---|
| A weight such as `0.001` kg or `1.255` kg was accepted; a tiny weight of a cheap item made a line worth ₹0.00 | Weights must be multiples of 0.01 kg, and a line amount that rounds to zero is rejected (400) |
| Booleans and arrays were accepted as quantities and prices (`true` became 1, `[5]` became 5) | Only numbers and numeric strings are accepted |
| `"Infinity"` and huge prices or supply quantities were accepted | Values must be finite; prices and supply quantities are capped at 100000 |
| A clerk could view another clerk's open transaction with `GET /transactions/:id` (found by reading the code while writing the access-control test; that test and the fix were made together, so I did not see it fail) | The route now applies the same ownership check as the other endpoints |

## Not covered

- The browser UI (`frontend/`) has no automated tests; it was checked by hand in the browser.
- There are no performance, load, security-scanning or mutation tests.
- Barcode reader and weighing scale are simulated by typing, so there is no hardware testing.
