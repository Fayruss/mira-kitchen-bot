# ARCHITECT.md

# Mira's Kitchen AI Bot

## Goal

An AI-powered Telegram ordering assistant for a small food business.

The bot should feel like talking to a real restaurant assistant.

---

# Architecture

Telegram

↓

Webhook

↓

Next.js API Route

↓

Conversation Engine

↓

Supabase

↓

Gemini

↓

Telegram Response

---

# Components

## 1. Telegram Webhook

Receives every message.

Normalizes incoming data.

Passes to Conversation Engine.

---

## 2. Conversation Engine

Heart of the application.

Responsibilities:

Load session

Detect admin commands

Check availability

Call Gemini if needed

Update session

Return response

---

## 3. Gemini Service

Only responsible for understanding language.

Examples:

"What do you sell?"

"I'm hungry"

"Can I get rice?"

"What is available today?"

Gemini returns structured JSON.

Never business logic.

---

## 4. Session Service

Stores

chat_id

current_state

customer_name

delivery_area

current_order

last_updated

Used for order collection.

---

## 5. Menu Service

Reads menu from Supabase.

Admin can update menu.

Customers always receive latest menu.

---

## 6. Availability Service

Single boolean.

OPEN

CLOSED

If closed:

Bot politely refuses new orders.

---

## 7. Order Service

Collect

Customer Name

Area

Items

Quantity

Confirmation

Save order

Notify Mira

Clear session

---

# Order Flow

START

↓

Greeting

↓

Ask Name

↓

Ask Delivery Area

↓

Ask Food

↓

Ask Quantity

↓

Confirmation

↓

Save Order

↓

Notify Mira

↓

Finished

---

# FAQ Flow

Customer asks question

↓

Gemini

↓

Answer

↓

End

---

# Menu Flow

Customer asks

↓

Supabase Menu

↓

Gemini formats nicely

↓

Customer receives menu

---

# Availability Flow

Customer message

↓

Check OPEN?

↓

No

↓

Send Closed Message

↓

Stop

---

# Admin Flow

/open

↓

Database = OPEN

↓

Success

---

/close

↓

Database = CLOSED

↓

Success

---

# Notification

New order

↓

Format nicely

↓

Send Telegram message to Mira

---

# Folder Structure

/app

/api

telegram

/services

gemini.ts

orders.ts

sessions.ts

menu.ts

availability.ts

telegram.ts

/lib

supabase.ts

types.ts

/utils

/prompts

faq.md

README.md

CLAUDE.md

ARCHITECT.md

---

# Development Order

Step 1

Telegram webhook

✅

Step 2

Supabase

Step 3

Session management

Step 4

Availability

Step 5

Menu

Step 6

Gemini FAQ

Step 7

Order collection

Step 8

Telegram notification

Step 9

Testing

Step 10

Deploy

---

# Definition of Done

✓ Customers can ask questions naturally.

✓ Customers can place a complete order.

✓ Mira receives every order on Telegram.

✓ Mira can open/close kitchen herself.

✓ Mira can edit menu without code.

✓ Bot is deployed.

✓ ForgePilot testers can use it immediately.