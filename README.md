# Supermarket Automation Software (SAS) - Group H

A full-stack web application that automates the day-to-day operations of a supermarket: billing at the counter, inventory management, price updates and sales reporting. 

## Problem statement

The supermarket stocks a set of items. Customers bring their items to a sales clerk, who scans each item's barcode and records its weight or quantity. SAS must:

- print a bill at the end of each sale with the serial number, item name, code, quantity, unit price, item price and total amount payable;
- keep the inventory up to date, reducing stock on every sale and letting an employee add stock when a new supply arrives;
- let the manager query inventory details on demand;
- print sales statistics (quantity sold, price realized, profit) for every item for any day or period;
- let the manager change item prices, since prices vary from day to day.

## Features

| Role | What they can do |
|---|---|
| **Sales clerk** | Start a transaction, scan a barcode, enter weight (by-weight items) or count (by-count items), remove a line before billing, finalize the sale, print the bill, confirm payment or cancel |
| **Stock employee** | Record a new supply (item code, quantity, supply date), see the item's current and post-update stock, view recent supplies |
| **Manager** | Search and filter inventory (low / out of stock), see stock value and margins, change item prices, generate sales statistics for one item or all items over any date range, print reports |

Other behaviour:
- Role-based access: every screen and API endpoint is restricted to the roles that need it.
- Stock is checked when an item is added, so a clerk cannot sell more than is in stock.
- A sale moves through the states in the state chart: initiated → adding items → billed → inventory updated → bill printed → completed, or cancelled. The server rejects out-of-order actions such as paying before the bill is printed.
- Each line item stores the price and cost at the time of sale, so changing a price never alters past bills or reported profit.
- Checkout (total, stock decrease and state change) runs as one database transaction.
- Only billed sales count in reports. Cancelled transactions never affect stock or statistics.

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML, CSS and JavaScript single-page app (no framework, no build step); Google Fonts (Bowlby One, Familjen Grotesk, Martian Mono); a small dependency-free Node static server for local use |
| Backend | Node.js (22.13+, built with 24) with Express 4; REST API returning JSON |
| Database | SQLite through Node's built-in `node:sqlite` module (no native build needed) |
| Auth | Username and password, hashed with `crypto.scrypt`; token sessions held in memory |
| Testing | Node's built-in test runner (`node:test`) and `assert`; 261 tests against throwaway databases (`npm test`) |

The only third-party dependency is `express`.

## Project structure

```
Diagrams/               UML diagrams (use case, class, activity, state chart, 3 sequence diagrams)
backend/
  server.js             Express app and CORS setup
  db.js                 SQLite schema, seed data, password hashing, transaction helper
  routes/api.js         REST endpoints and role guards
  services/
    inventory.js        Item / Inventory logic (query, stock in/out, price change, supplies)
    transaction.js      SalesTransaction / LineItem / Bill logic and state transitions
    report.js           Sales statistics
  tests/                Automated tests (unit, whitebox, integration, blackbox, system)
frontend/
  index.html            Page shell
  app.js                Login, role-based views, API calls
  style.css             Visual design
  config.js             Backend API URL
  server.js             Tiny static file server
```

## Getting started

Requirements: Node.js 22.13 or newer.

Run the backend and frontend in two terminals.

```bash
# Terminal 1: backend API on http://localhost:3000
cd backend
npm install
npm start
```

```bash
# Terminal 2: frontend on http://localhost:5173
cd frontend
npm start
```

Open http://localhost:5173. On first run the backend creates `backend/sas.db` and fills it with three staff accounts and ten sample items.

To reset the data, stop the backend and delete `backend/sas.db`.

### Demo accounts

| Role | Username | Password |
|---|---|---|
| Sales clerk | `clerk` | `clerk123` |
| Stock employee | `stock` | `stock123` |
| Manager | `manager` | `manager123` |

Sample barcodes: `1001`–`1005` are sold by weight (the clerk types the weight in kg); `2001`–`2005` are sold by count.

### Tests

```bash
cd backend
npm test                 # all 261 tests
npm run test:coverage    # with a statement / branch coverage report
```

The suite covers unit, white-box, integration, black-box and system testing. See [TESTING.md](TESTING.md) for the techniques, requirement traceability, coverage numbers and the defects the tests found. Tests use a throwaway database and never touch `sas.db`.

### Configuration

| Setting | Where | Default | Purpose |
|---|---|---|---|
| `PORT` | backend environment | `3000` | Backend port |
| `SAS_DB` | backend environment | `backend/sas.db` | Path of the SQLite file |
| `FRONTEND_ORIGIN` | backend environment | `*` | Origin allowed by CORS; set to your frontend URL in production |
| `PORT` | frontend environment | `5173` | Frontend static server port |
| `SAS_API` | `frontend/config.js` | `http://localhost:3000/api` | Base URL of the backend API |

## API overview

All endpoints are under `/api`. Except `/login`, they need an `Authorization: Bearer <token>` header from the login response.

| Method and path | Role | Purpose |
|---|---|---|
| `POST /login`, `POST /logout` | all | Sign in and out |
| `GET /items`, `GET /items/:code` | clerk | List items, look up an item by barcode |
| `POST /transactions` | clerk | Start a sale |
| `GET /transactions/:id` | clerk | Current state of a sale |
| `POST /transactions/:id/items` | clerk | Add a line `{code, qty}` |
| `DELETE /transactions/:id/items/:lineId` | clerk | Remove a line before billing |
| `POST /transactions/:id/checkout` | clerk | Finalize: total, decrease stock, generate bill |
| `POST /transactions/:id/pay` | clerk | Mark the bill as paid |
| `POST /transactions/:id/cancel` | clerk | Cancel before billing |
| `POST /inventory/supply` | stock | Record a supply `{code, qty, supplyDate}` |
| `GET /inventory/supplies`, `GET /stock-items` | stock | Recent supplies, item list |
| `GET /inventory?q=` | manager | Query inventory by code or name |
| `PUT /items/:code/price` | manager | Change an item's price |
| `GET /reports/sales?code=all\|X&from&to` | manager | Quantity sold, revenue and profit per item |

## Database

| Table | Purpose |
|---|---|
| `employees` | Staff accounts (`clerk`, `stock`, `manager`) with hashed passwords |
| `items` | Item code, name, unit price, cost price, stock quantity, sold by weight or count, unit |
| `transactions` | One row per sale with datetime, total, status and the clerk |
| `line_items` | Items on a sale, with quantity, price at sale, cost at sale and amount |
| `supplies` | Log of stock arrivals |

## How the diagrams map to the code

| Diagram | Implementation |
|---|---|
| Use case | The four role screens and the endpoints above |
| Class: Employee (`login`) | `backend/routes/api.js` `/login`, `employees` table |
| Class: Item / Inventory | `backend/services/inventory.js` (`findItem`, `queryInventory`, `decreaseStock`, `increaseStock`, `updatePrice`), `items` table |
| Class: SalesTransaction / LineItem / Bill | `backend/services/transaction.js` (`addLineItem`, `calculateTotal`, `generateBill`), `transactions` and `line_items` tables |
| Class: SalesStatistics | `backend/services/report.js` |
| Class: BarcodeReader / WeighingScale (devices) | Simulated by input fields: the clerk types the barcode and the weight or quantity |
| State chart | `transactions.status`, enforced in `backend/services/transaction.js` |
| Activity diagram | Clerk screen flow: scan, weight or count, price = qty × unit price, repeat, total, bill, stock decrease, payment |
| Sequence: Sales Transaction | `POST /transactions`, `/items`, `/checkout`, `/pay` |
| Sequence: Update Inventory | `POST /inventory/supply` (validate code, increase stock, confirmation) and the `supplies` table |
| Sequence: Generate Report | `GET /reports/sales` (quantity sold, revenue, profit per item) |

## Known limitations

- The barcode reader and weighing scale are simulated by typing into fields; there is no hardware integration.
- Login sessions are stored in memory, so everyone is logged out when the backend restarts.
- No login rate limiting and no automatic database backups.
- Report dates use the server's local calendar day.