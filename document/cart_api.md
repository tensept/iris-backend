# Cart API Documentation

## Overview
API สำหรับจัดการตะกร้าสินค้า (Shopping Cart) ของผู้ใช้งาน รองรับการเพิ่ม แก้ไข ลบ และดูรายการสินค้าในตะกร้า

**Base URL:** `/cart`

## Authentication
ทุก endpoint ต้องการการ authentication ผ่าน token (ผ่าน authMiddleware)
- ระบบจะดึง `userId` จาก token ที่ส่งมา
- หากไม่มี authentication จะได้รับ status code `401`

---

## Endpoints

### 1. เพิ่มสินค้าลงตะกร้า (Add Item to Cart)

**POST** `/cart/items`

เพิ่มสินค้าลงในตะกร้า หากยังไม่มีตะกร้าจะสร้างใหม่ให้อัตโนมัติ หากสินค้านั้นมีอยู่แล้วจะเพิ่มจำนวน

#### Request Body
```json
{
  "variant_id": 1,
  "qty": 2
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| variant_id | number | Yes | ID ของ product variant |
| qty | number | Yes | จำนวนที่ต้องการเพิ่ม |

#### Response

**Success (201 Created)**
```json
{
  "message": "Cart item added successfully",
  "cartItem": {
    "id": 1,
    "cartId": 1,
    "variantId": 1,
    "qty": 2,
    "unitPrice": "299.00",
    "lineTotal": "598.00",
    "createdAt": "2025-01-15T10:30:00.000Z",
    "updatedAt": "2025-01-15T10:30:00.000Z"
  },
  "cartId": 1
}
```

หากสินค้ามีอยู่ในตะกร้าแล้ว message จะเป็น:
```json
{
  "message": "Cart item quantity updated",
  "cartItem": { ... },
  "cartId": 1
}
```

**Error Responses**
- `400` - Not enough stock (สต็อกไม่เพียงพอ)
- `401` - User not authenticated
- `404` - Product variant not found

#### Business Logic
1. ตรวจสอบ authentication
2. หาหรือสร้างตะกร้าสำหรับ user (auto-create)
3. ตรวจสอบสต็อกสินค้า
4. หากสินค้ามีในตะกร้าแล้ว:
   - เพิ่ม qty (ไม่ใช่แทนที่)
   - ตรวจสอบสต็อกกับจำนวนรวมใหม่
   - คำนวณ lineTotal ใหม่
5. หากยังไม่มี: สร้าง cart item ใหม่
6. **ลดสต็อกสินค้าทันที**

---

### 2. ดูรายการสินค้าในตะกร้า (Get Cart Items)

**GET** `/cart/items`

ดึงข้อมูลสินค้าทั้งหมดในตะกร้าของ user ปัจจุบัน

#### Request
ไม่ต้องส่ง parameter (ใช้ userId จาก token)

#### Response

**Success (200 OK)**
```json
{
  "cartItems": [
    {
      "id": 1,
      "cartId": 1,
      "variantId": 1,
      "qty": 2,
      "unitPrice": "299.00",
      "lineTotal": "598.00",
      "createdAt": "2025-01-15T10:30:00.000Z",
      "updatedAt": "2025-01-15T10:30:00.000Z"
    },
    {
      "id": 2,
      "cartId": 1,
      "variantId": 3,
      "qty": 1,
      "unitPrice": "499.00",
      "lineTotal": "499.00",
      "createdAt": "2025-01-15T11:00:00.000Z",
      "updatedAt": "2025-01-15T11:00:00.000Z"
    }
  ]
}
```

หากยังไม่มีตะกร้า:
```json
{
  "cartItems": []
}
```

**Error Responses**
- `401` - User not authenticated

---

### 3. แก้ไขจำนวนสินค้าในตะกร้า (Update Cart Item Quantity)

**PUT** `/cart/items/:id`

อัปเดตจำนวนสินค้าในตะกร้า หาก qty = 0 จะลบสินค้าออกจากตะกร้าและคืนสต็อกทั้งหมด

#### URL Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| id | number | Cart Item ID |

#### Request Body
```json
{
  "qty": 3
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| qty | number | Yes | จำนวนใหม่ที่ต้องการตั้ง (≥ 0) <br>**หมายเหตุ:** เป็นการ SET ค่าใหม่ ไม่ใช่การเพิ่ม/ลด |

#### Response

**Success (200 OK) - กรณี qty > 0**
```json
{
  "message": "Cart item updated successfully",
  "item": {
    "id": 1,
    "cartId": 1,
    "variantId": 1,
    "qty": 3,
    "unitPrice": "299.00",
    "lineTotal": "897.00",
    "updatedAt": "2025-01-15T12:00:00.000Z"
  }
}
```

**Success (200 OK) - กรณี qty = 0**
```json
{
  "message": "Cart item removed because qty is 0"
}
```

**Error Responses**
- `400` - Invalid qty value / Missing qty / Not enough stock
- `401` - User not authenticated
- `404` - Cart not found / Cart item not found / Product variant not found

#### Business Logic
1. ตรวจสอบ authentication และ validation
2. หา cart และ cart item ของ user
3. คำนวณ `stockChange = newQty - currentQty`
   - ถ้า stockChange > 0 = ต้องการสินค้าเพิ่ม (ลดสต็อก)
   - ถ้า stockChange < 0 = ลดจำนวนสินค้า (คืนสต็อก)
4. ตรวจสอบสต็อกว่าเพียงพอหรือไม่
5. **หาก qty = 0**:
   - ลบ item ออกจากตะกร้า
   - คืนสต็อกทั้งหมด (`existingItem.qty`)
6. **หาก qty > 0**:
   - อัปเดต qty และ lineTotal
   - ปรับสต็อกตาม stockChange

---

### 4. ลบสินค้าออกจากตะกร้า (Delete Cart Item)

**DELETE** `/cart/items/:id`

ลบสินค้าออกจากตะกร้า **และคืนสต็อกสินค้าทั้งหมดกลับคลัง**

#### URL Parameters
| Parameter | Type | Description |
|-----------|------|-------------|
| id | number | Cart Item ID |

#### Response

**Success (200 OK)**
```json
{
  "message": "Cart item deleted successfully and stock restored"
}
```

**Error Responses**
- `401` - User not authenticated
- `404` - Cart not found / Cart item not found

#### Business Logic
1. ตรวจสอบ authentication
2. หา cart ของ user
3. หา cart item ที่ต้องการลบ
4. **คืนสต็อกให้กับ product variant** (`stockQty + existingItem.qty`)
5. ลบ cart item

---

## Data Models

### Cart
```typescript
{
  id: number;
  userID: number;
  createdAt: Date;
  updatedAt: Date;
}
```

### Cart Item
```typescript
{
  id: number;
  cartId: number;
  variantId: number;
  qty: number;
  unitPrice: string; // Decimal as string (e.g., "299.00")
  lineTotal: string; // Decimal as string (e.g., "598.00")
  createdAt: Date;
  updatedAt: Date;
}
```

---

## Stock Management (การจัดการสต็อก)

### กลไกการจัดการสต็อก

| Operation | Action | Stock Behavior |
|-----------|--------|----------------|
| **POST** `/cart/items` | เพิ่มสินค้าเข้าตะกร้า | ลดสต็อกทันที (`-qty`) |
| **PUT** `/cart/items/:id` (เพิ่ม qty) | เปลี่ยนจาก 2 → 5 | ลดสต็อก 3 หน่วย (`-stockChange`) |
| **PUT** `/cart/items/:id` (ลด qty) | เปลี่ยนจาก 5 → 2 | คืนสต็อก 3 หน่วย (`+stockChange`) |
| **PUT** `/cart/items/:id` (qty=0) | ตั้งค่าเป็น 0 | คืนสต็อกทั้งหมด + ลบ item |
| **DELETE** `/cart/items/:id` | ลบสินค้า | **คืนสต็อกทั้งหมด** |

### หลักการสำคัญ
1. **สต็อกถูกสำรองทันทีเมื่อเพิ่มเข้าตะกร้า** - ป้องกันการซื้อเกินสต็อก
2. **PUT และ DELETE ทั้งคู่คืนสต็อก** - สอดคล้องกัน
3. **ใช้ Decimal.js** สำหรับการคำนวณราคาเพื่อความแม่นยำ

### สูตรการคำนวณ
```typescript
stockChange = newQty - currentQty
// ถ้า stockChange > 0 → ต้องลดสต็อก
// ถ้า stockChange < 0 → คืนสต็อก

lineTotal = unitPrice × qty
newStockQty = currentStockQty - stockChange
```

---

## Important Notes

### การสร้างตะกร้าอัตโนมัติ (Auto-create Cart)
- ไม่ต้องมี endpoint สำหรับสร้างตะกร้าแยก
- ระบบจะสร้างให้อัตโนมัติเมื่อ user เพิ่มสินค้าครั้งแรก
- 1 user มีได้ 1 cart เท่านั้น

### การตรวจสอบสต็อก
- ตรวจสอบก่อนทุกครั้งที่มีการเปลี่ยนแปลง qty
- หาก stock ไม่เพียงพอ จะ return error 400
- ใช้สต็อกปัจจุบัน + stockChange ในการตรวจสอบ

### ความปลอดภัย (Security)
- ตรวจสอบว่า cart item เป็นของ user ที่ login อยู่จริง
- ใช้ `and()` ในการ query เพื่อตรวจสอบทั้ง `id` และ `cartId`
- ป้องกันการแก้ไข/ลบสินค้าของคนอื่น

### การจัดการข้อผิดพลาด
- ทุก endpoint ใช้ `try-catch` 
- ส่งต่อ error ไปยัง error handler middleware ผ่าน `next(err)`
- Error codes ที่ใช้:
  - `400` - Bad Request (invalid input, not enough stock)
  - `401` - Unauthorized (missing or invalid token)
  - `404` - Not Found (cart, item, or variant not found)
  - `500` - Internal Server Error (handled by error middleware)

---

## Example Usage Flow

### ตัวอย่างการใช้งานทั่วไป

```javascript
// 1. เพิ่มสินค้าเข้าตะกร้าครั้งแรก
POST /cart/items
Body: { "variant_id": 1, "qty": 2 }
→ สร้าง cart ใหม่ + เพิ่ม item (สต็อก -2)

// 2. เพิ่มสินค้าตัวเดิมอีก
POST /cart/items
Body: { "variant_id": 1, "qty": 1 }
→ qty กลายเป็น 3 (สต็อก -1)

// 3. ดูตะกร้า
GET /cart/items
→ ได้ array ของ cart items ทั้งหมด

// 4. แก้ไขจำนวน (เปลี่ยนจาก 3 เป็น 5)
PUT /cart/items/1
Body: { "qty": 5 }
→ qty = 5 (สต็อก -2)

// 5. ลดจำนวน (เปลี่ยนจาก 5 เป็น 2)
PUT /cart/items/1
Body: { "qty": 2 }
→ qty = 2 (คืนสต็อก +3)

// 6. ลบสินค้า
DELETE /cart/items/1
→ ลบ item (คืนสต็อก +2)
```

---

## Version History

**Current Version:** 1.0  
**Last Updated:** January 2025

### Changes from Previous Version
- ✅ DELETE endpoint now restores stock (เพิ่มการคืนสต็อก)
- ✅ Improved stock validation logic
- ✅ Better error messages and consistency