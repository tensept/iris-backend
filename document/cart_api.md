# Shopping Cart API Documentation

## Base URL
```
/cart
```

---

## 📋 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/cart` | Create a new cart |
| POST | `/cart/items` | Add item to cart |
| POST | `/cart/items/get` | Get all cart items |
| PUT | `/cart/items/:id` | Update cart item quantity |
| DELETE | `/cart/items/:id` | Delete cart item |

---

## 1️⃣ Create New Cart

### `POST /cart`

Creates a new empty cart for a user or session. Returns 409 if cart already exists.

**Request Body:**
```json
{
  "userId": 123,           // optional (integer)
  "sessionId": "guest-xyz" // optional (string)
}
```

**Validation:**
- Either `userId` OR `sessionId` is required
- Cannot create duplicate cart for same user/session

**Success Response (201 Created):**
```json
{
  "message": "Cart created successfully",
  "cart": {
    "id": 1,
    "userID": 123,
    "sessionId": null,
    "createdAt": "2025-10-04T10:30:00.000Z",
    "updatedAt": "2025-10-04T10:30:00.000Z"
  }
}
```

**Error Response (409 Conflict):**
```json
{
  "message": "Cart already exists",
  "cartId": 1
}
```

**Error Response (400 Bad Request):**
```json
{
  "message": "Either userId or sessionId is required"
}
```

---

## 2️⃣ Add Item to Cart

### `POST /cart/items`

Adds an item to cart. **Automatically creates cart if it doesn't exist.**

**Request Body:**
```json
{
  "userId": 123,              // optional (integer)
  "sessionId": "guest-xyz",   // optional (string)
  "variant_id": 456,          // required (integer) - product variant ID
  "qty": 2,                   // required (integer > 0)
  "unit_price": 29.99         // required (decimal)
}
```

**Validation:**
- Either `userId` OR `sessionId` is required
- `variant_id`, `qty`, and `unit_price` are required
- `qty` must be greater than 0

**Behavior:**
- If cart doesn't exist → creates new cart automatically
- Creates new cart item with calculated `lineTotal`
- `lineTotal` = `qty` × `unit_price` (rounded to 2 decimals)

**Success Response (201 Created):**
```json
{
  "message": "Cart item added successfully",
  "cartItem": {
    "id": 10,
    "cartId": 1,
    "variantId": 456,
    "qty": 2,
    "unitPrice": "29.99",
    "lineTotal": "59.98",
    "createdAt": "2025-10-04T10:35:00.000Z",
    "updatedAt": "2025-10-04T10:35:00.000Z"
  },
  "cartId": 1
}
```

**Error Response (400 Bad Request):**
```json
{
  "message": "Either userId or sessionId is required"
}
```

---

## 3️⃣ Get Cart Items

### `POST /cart/items/get`

Retrieves all items in a cart for a specific user or session.

**Request Body:**
```json
{
  "userId": 123,              // optional (integer)
  "sessionId": "guest-xyz"    // optional (string)
}
```

**Validation:**
- Either `userId` OR `sessionId` is required

**Behavior:**
- If cart not found → returns empty array (not 404)

**Success Response (200 OK) - Cart Found:**
```json
{
  "message": "Cart items retrieved successfully",
  "cartId": 1,
  "cartItems": [
    {
      "id": 10,
      "cartId": 1,
      "variantId": 456,
      "qty": 2,
      "unitPrice": "29.99",
      "lineTotal": "59.98",
      "createdAt": "2025-10-04T10:35:00.000Z",
      "updatedAt": "2025-10-04T10:35:00.000Z"
    },
    {
      "id": 11,
      "cartId": 1,
      "variantId": 789,
      "qty": 1,
      "unitPrice": "49.99",
      "lineTotal": "49.99",
      "createdAt": "2025-10-04T10:36:00.000Z",
      "updatedAt": "2025-10-04T10:36:00.000Z"
    }
  ]
}
```

**Success Response (200 OK) - Cart Not Found:**
```json
{
  "message": "Cart not found",
  "cartItems": []
}
```

**Error Response (400 Bad Request):**
```json
{
  "message": "Either userId or sessionId is required"
}
```

---

## 4️⃣ Update Cart Item Quantity

### `PUT /cart/items/:id`

Updates the quantity of a specific cart item. **Automatically recalculates `lineTotal`.**

**URL Parameters:**
- `id` (integer) - Cart item ID

**Request Body:**
```json
{
  "qty": 5  // required (integer > 0)
}
```

**Validation:**
- `qty` is required and must be greater than 0
- To remove an item, use DELETE endpoint instead

**Behavior:**
- Updates `qty` and recalculates `lineTotal`
- `lineTotal` = new `qty` × existing `unitPrice`
- Updates `updatedAt` timestamp

**Success Response (200 OK):**
```json
{
  "message": "Cart item updated successfully",
  "cartItem": {
    "id": 10,
    "cartId": 1,
    "variantId": 456,
    "qty": 5,
    "unitPrice": "29.99",
    "lineTotal": "149.95",
    "createdAt": "2025-10-04T10:35:00.000Z",
    "updatedAt": "2025-10-04T10:45:00.000Z"
  }
}
```

**Error Response (404 Not Found):**
```json
{
  "message": "Cart item not found"
}
```

**Error Response (400 Bad Request):**
```json
{
  "message": "qty is required and must be greater than 0"
}
```

---

## 5️⃣ Delete Cart Item

### `DELETE /cart/items/:id`

Removes a specific item from the cart completely.

**URL Parameters:**
- `id` (integer) - Cart item ID

**Success Response (200 OK):**
```json
{
  "message": "Cart item deleted successfully",
  "cartItemId": "10"
}
```

**Error Response (404 Not Found):**
```json
{
  "message": "Cart item not found"
}
```

---

## 🔄 Common Usage Flows

### **Flow 1: Guest User Shopping**

```bash
# Step 1: Add first item (cart auto-created)
POST /cart/items
{
  "sessionId": "guest-abc123",
  "variant_id": 101,
  "qty": 2,
  "unit_price": 19.99
}
# Response: cartId: 1, cartItem created

# Step 2: Add second item
POST /cart/items
{
  "sessionId": "guest-abc123",
  "variant_id": 102,
  "qty": 1,
  "unit_price": 39.99
}
# Response: uses same cartId: 1

# Step 3: View cart
POST /cart/items/get
{
  "sessionId": "guest-abc123"
}
# Response: 2 items, total value: $79.97

# Step 4: Update quantity
PUT /cart/items/1
{
  "qty": 3
}
# Response: lineTotal updated to $59.97

# Step 5: Remove item
DELETE /cart/items/2
# Response: item deleted
```

### **Flow 2: Logged-in User**

```bash
# Step 1: Create cart explicitly
POST /cart
{
  "userId": 456
}
# Response: cart created with id: 5

# Step 2: Add items
POST /cart/items
{
  "userId": 456,
  "variant_id": 201,
  "qty": 1,
  "unit_price": 99.99
}

# Step 3: Get cart items
POST /cart/items/get
{
  "userId": 456
}

# Step 4: Update and delete as needed
PUT /cart/items/15 { "qty": 2 }
DELETE /cart/items/15
```

---

## 💡 Important Notes

### **Price Handling**
- All prices use **Decimal.js** for precise calculations
- Prices stored as **strings with 2 decimal places**: `"29.99"`
- `lineTotal` is always calculated: `qty × unitPrice`

### **Auto-create Behavior**
- `POST /cart/items` automatically creates cart if needed
- No need to call `POST /cart` first (optional)

### **User vs Session**
- **userId** - For authenticated/logged-in users
- **sessionId** - For guest/anonymous users
- Only one is needed per request

### **Cart Item ID**
- Each cart item has unique `id`
- Use this `id` for UPDATE and DELETE operations
- Different from `variantId` (product variant)

### **Empty Cart Handling**
- `POST /cart/items/get` returns empty array if cart not found
- Does NOT return 404 error
- Graceful handling for new users

---

## 📊 Status Codes Summary

| Code | Meaning | Used In |
|------|---------|---------|
| 200 | OK | GET cart items, UPDATE, DELETE |
| 201 | Created | POST cart, POST cart items |
| 400 | Bad Request | Missing required fields, invalid data |
| 404 | Not Found | Cart item doesn't exist |
| 409 | Conflict | Cart already exists (POST /cart) |

---

## 🗂️ Data Models

### **Cart**
```typescript
{
  id: number;
  userID: number | null;
  sessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
```

### **Cart Item**
```typescript
{
  id: number;
  cartId: number;
  variantId: number;
  qty: number;
  unitPrice: string;      // "29.99"
  lineTotal: string;      // "59.98"
  createdAt: Date;
  updatedAt: Date;
}
```

---

## 🔧 Technical Details

### **Dependencies**
- `decimal.js` - For precise decimal calculations
- `drizzle-orm` - Database ORM
- `express` - Web framework

### **Database Tables**
- `carts` - Stores cart information
- `cartItems` - Stores individual items in each cart

### **Precision**
- All monetary values rounded to 2 decimal places
- Uses `Decimal.js` to avoid floating-point errors
- Example: `new Decimal(2).mul(29.99).toFixed(2)` → `"59.98"`