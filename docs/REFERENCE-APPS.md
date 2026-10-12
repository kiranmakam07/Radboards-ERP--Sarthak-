# Reference apps: what they do, what RadCore has, what to build

Founder, 12 Oct 2026: take Vyapar as the reference for accounts, Privyr for CRM and Attendo for HR,
find their critical features and bring them into RadCore.

**How this was done.** The founder suggested the "Reverse Engineer Anything" (REA) tool. REA
decompiles an app so that an AI agent can trace how a feature works. It was not run on these three
apps: their features are published, two of them are in daily use here, and decompiling a commercial
app is against its terms of use (REA's own README limits it to software one owns or is authorised
to examine). The same method (understand the feature, then write our own) was applied to each
vendor's public feature pages instead. Nothing was copied from any of them: no code, text or design.

Sources read on 12 Oct 2026: vyaparapp.in (home and feature pages), privyr.com (home and
"new lead automations"), and public descriptions of Attendo. **Attendo is the least certain of the
three**: several products carry that name and its own site was not found, so the list below is the
common core of that kind of app (clock in and out from a phone with location, breaks, absences,
leave). Sarthak to confirm which Attendo is meant.

Status: ✅ in RadCore · 🔨 being built now · 🔌 built, waits for an account to be connected ·
⏭ later · ➖ not needed here.

## Accounts (reference: Vyapar)

| What Vyapar offers | RadCore | Note |
| --- | --- | --- |
| GST and non-GST bills, several tax rates on one bill, automatic numbering | ✅ | |
| Quotation → order → delivery challan → invoice | ✅ | |
| Counter (POS) billing with barcode, several payment modes on one bill | ✅ | Quick bill |
| Item-level discount | ✅ | |
| Discount or extra charge on the whole bill (packing, freight) | ⏭ | Shipping is a line; a bill-level discount is not there |
| Stock in real time, low-stock list, purchase orders, inward and QC | ✅ | |
| Who owes what, ageing, payments against bills | ✅ | |
| **Payment reminders to customers** | ✅ | Accounts → To collect: one tap, message written with the amounts and a link to each bill. Sent by hand, not on a timer |
| **Bill sent to the customer on WhatsApp** | ✅ | A link the customer opens, no sign-in; shows what is still to pay |
| Party statement | ✅ | Sent on WhatsApp with the reminder |
| Expenses with GST, bank and cash books, bank reconciliation | ✅ | Reconciliation goes further than Vyapar's |
| **Cash put in the bank, cash drawn, bank to bank** | ✅ | Accounts → Cash & bank transfers |
| **Profit on each bill** | ✅ | Books & reports → Profit by bill |
| Sales, stock, profit, GST reports; trial balance, P&L, balance sheet | ✅ | |
| GSTR-1 for the portal | ✅ | |
| E-invoice and e-way bill | ⏭ | Needs registration with a GST service provider |
| Bill formats with logo; thermal printer | ✅ | Logo on the bill: ⏭ |
| Barcode labels to print | ⏭ | Scanning is there |
| Staff sign-ins with roles; backups | ✅ | |
| Purchase bill read from a photo | ⏭ | |
| Online store | ➖ | Shopify is the store; its orders come in |
| Raw material used up in making goods (bill of materials) | ⏭ | Not in the PRD; say if wanted |
| Tally import / export | ⏭ | |

## CRM (reference: Privyr)

| What Privyr offers | RadCore | Note |
| --- | --- | --- |
| Leads straight from Meta ads, Google ads, website forms, WhatsApp | 🔌 | |
| Alert the moment a lead arrives | ✅ | While the app is open or installed |
| One tap to WhatsApp or call a new lead, message already written | ✅ | Quick replies |
| Leads shared out among the team automatically | ✅ | |
| Timeline of everything that happened with a lead | ✅ | |
| Files sent with "they opened it" tracking | ✅ | |
| Pipeline on the phone | ✅ | |
| **Follow-up sequences over days and weeks** | ✅ | CRM → Follow-up plans. Each step comes up on its day with the message one tap away; a person presses send (nothing goes out by itself until the WhatsApp number is connected) |
| **Many leads at once** (assign, message one after another) | ✅ | Tick leads on the list: hand them to someone, or message them one tap each |
| **Leads brought in from a spreadsheet** | ✅ | Leads → Bring in from a spreadsheet (CSV) |
| Automatic first WhatsApp to a new lead, day or night | 🔌 | Needs the WhatsApp number connected and an approved template |
| Messages sent from the business number | 🔌 | |
| Team dashboard: who has how many, who is converting | ✅ | Marketing dashboard → The team, person by person |
| Lead results sent back to Meta to improve the ads | ⏭ | |
| WhatsApp campaigns to thousands | ⏭ | Needs approved templates; easy to get a number banned if rushed |

## HR (reference: Attendo)

Attendo is Petpooja's attendance and payroll product (it was called Petpooja Payroll; Sarthak
confirmed the Play Store listing on 12 Oct 2026). Its features below are from Petpooja's own page
about the rename.

| What Attendo offers | RadCore | Note |
| --- | --- | --- |
| **Punch from the phone, with where it was done** | ✅ | On "My work". A clock-in away from the workplace is taken and flagged with the distance |
| Photo with the phone punch | ⏭ | |
| Fingerprint, card and face devices on the wall | ➖ | Hardware; the phone and the register cover it here |
| Register by day, monthly summary (muster), export | ✅ | |
| **Asking for leave and having it approved** | ✅ | One approval, by HR. Approved leave goes into the register by itself |
| Leave balances | ✅ | |
| Late arrivals and hours worked | ✅ | From a start time and a grace period |
| Shifts: rotating, overnight, 24-hour | ⏭ | One start time for everyone today |
| Weekly off | ✅ | Set once; needs no marking |
| Holiday list | ⏭ | A holiday is marked in the register on the day |
| **Salary worked out from attendance, by month** | ✅ | HR → Payroll. Paid days are days worked, paid leave, weekly offs and holidays |
| Daily, weekly and hourly pay | ⏭ | Monthly salaries only |
| **Advances and loans taken back out of salary** | ✅ | A set amount a month, never more than is earned |
| **PF and ESIC worked out; professional tax and TDS** | ✅ | PF and ESIC by the usual rates, switched on per person; professional tax and TDS as an amount per person |
| Labour welfare fund | ⏭ | |
| **Payslips, sent on WhatsApp** | ✅ | A link the person opens; also on their own "My work" |
| **List for the bank to pay the salaries** | ✅ | Excel |
| Salary in the books | ✅ | Beyond Attendo: approving a month posts the expense and what is owed; paying it clears the bank |
| Staff ask for a missed punch to be corrected | ⏭ | HR corrects the register |
| Sign-in by WhatsApp code; 11 languages | ⏭ | |
| Hiring, interviews, employee records | ✅ | Beyond what Attendo does |
