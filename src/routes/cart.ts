import { Router } from "express";
import { dbClient } from "../../db/client.ts";
import { carts, cartItems } from "../../db/schema.ts";
import { Decimal } from "decimal.js";
import { eq } from "drizzle-orm";

const cartRouter = Router();

// Use for: add items to cart
/*
 Step: Find a cart from userId if it doesn't exist, create new
 else create new cart item and use that cartId
*/
cartRouter.post("/items", async (req, res, next) => {
  try {
    const { userId, sessionId, variant_id, qty, unit_price } = req.body;

    // validate payload
    if (!userId && !sessionId) {
      return res.status(400).json({ 
        message: "Either userId or sessionId is required" 
      });
    }

    // find or create a cart
    let existingCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => {
        if (userId) {
          return eq(carts.userID, userId);
        }
        return eq(carts.sessionId, sessionId);
      }
    });

    // ถ้าไม่เจอ cart ให้สร้างใหม่
    if (!existingCart) {
      const newCart = await dbClient.insert(carts).values({
        userID: userId || null,
        sessionId: sessionId || null,
        createdAt: new Date(),
        updatedAt: new Date()
      }).returning(); // returning() จะคืน object ของ cart ใหม่

      existingCart = newCart[0];
    }

    const qtyNum = Number(qty);
    const unitPriceNum = Number(unit_price);

    // สร้าง cart item ใหม่
    const newCartItem = await dbClient.insert(cartItems).values({
        cartId: existingCart.id,
        variantId: Number(variant_id),
        qty: qtyNum,
        unitPrice: new Decimal(unitPriceNum).toFixed(2), // string แบบ 2 decimal
        lineTotal: new Decimal(qtyNum).mul(unitPriceNum).toFixed(2), // string แบบ 2 decimal
        createdAt: new Date(),
        updatedAt: new Date()
    }).returning();

    // Return 201 Created with the new cart item
    return res.status(201).json({
      message: "Cart item added successfully",
      cartItem: newCartItem[0],
      cartId: existingCart.id
    });

  } catch (err) {
    next(err);
  }
});

/* ========== READ ========== */
// Use for: get all items in cart
/*
 Step: Find a cart from userId (or sessionId) and get all cart items.
       If not found, return empty object
*/
cartRouter.post("/items/get", async (req, res, next) => {
  try {
    const { userId, sessionId } = req.body;

    // validate payload
    if (!userId && !sessionId) {
      return res.status(400).json({ 
        message: "Either userId or sessionId is required" 
      });
    }

    // หา cart ก่อน
    const existingCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => {
        if (userId) return eq(carts.userID, userId);
        return eq(carts.sessionId, sessionId);
      }
    });

    if (!existingCart) {
      // ถ้าไม่เจอ cart → return empty object
      return res.status(200).json({
        message: "Cart not found",
        cartItems: [],
      });
    }

    // หา cart items ทั้งหมด
    const items = await dbClient.query.cartItems.findMany({
      where: (cartItems, { eq }) => eq(cartItems.cartId, existingCart.id)
    });

    return res.status(200).json({
      message: "Cart items retrieved successfully",
      cartId: existingCart.id,
      cartItems: items
    });

  } catch (err) {
    next(err);
  }
});

/* ========== UPDATE ========== */
// Use for: update items in cart
/*
 Step: Update by using id to query and can update only qty
*/
cartRouter.put("/items/:id", async (req, res, next) => {
  try {
    const { id } = req.params; // cartItem id
    const { qty } = req.body;

    if (!qty || Number(qty) <= 0) {
      return res.status(400).json({ message: "qty is required and must be greater than 0" });
    }

    // หา cart item ก่อน
    const existingItem = await dbClient.query.cartItems.findFirst({
      where: (cartItems, { eq }) => eq(cartItems.id, Number(id))
    });

    if (!existingItem) {
      return res.status(404).json({ message: "Cart item not found" });
    }

    const qtyNum = Number(qty);
    const unitPriceNum = Number(existingItem.unitPrice); // ใช้ unitPrice เดิม

    // อัปเดต qty และ lineTotal ด้วย Decimal.js
    const updatedItem = await dbClient.update(cartItems)
      .set({
        qty: qtyNum,
        lineTotal: new Decimal(qtyNum).mul(unitPriceNum).toFixed(2), // string แบบ 2 decimal
        updatedAt: new Date()
      })
      .where(eq(cartItems.id, Number(id)))
      .returning();

    return res.status(200).json({
      message: "Cart item updated successfully",
      cartItem: updatedItem[0]
    });

  } catch (err) {
    next(err);
  }
});

/* ========== DELETE ========== */
// Use for: delete item from cart by id
/*
 Step: Query by using id and delete that data
*/
cartRouter.delete("/items/:id", async (req, res, next) => {
  try {
    const { id } = req.params; // cartItem id

    // ตรวจสอบว่า cart item มีอยู่ไหม
    const existingItem = await dbClient.query.cartItems.findFirst({
      where: (cartItems, { eq }) => eq(cartItems.id, Number(id))
    });

    if (!existingItem) {
      return res.status(404).json({ message: "Cart item not found" });
    }

    // ลบ cart item
    await dbClient.delete(cartItems)
      .where(eq(cartItems.id, Number(id)));

    return res.status(200).json({
      message: "Cart item deleted successfully",
      cartItemId: id
    });

  } catch (err) {
    next(err);
  }
});


export { cartRouter };
