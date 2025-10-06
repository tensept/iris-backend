import { Router } from "express";
import { dbClient } from "../../db/client.ts";
import { carts, cartItems, productVariants } from "../../db/schema.ts";
import { eq, and } from "drizzle-orm";
import { Decimal } from "decimal.js";

const cartRouter = Router();

/* 
===============================
= CREATE =
Use for: Add items to cart
Step:
1. ดึง userId จาก token (ผ่าน authMiddleware)
2. Find cart จาก userId ถ้าไม่มีให้สร้างใหม่
3. Create cart item ใหม่ และผูกกับ cartId นั้น
===============================
*/
cartRouter.post("/items", async (req, res, next) => {
  try {
    const { variant_id, qty } = req.body;
    const { user } = req as any;
    const userId = user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // หา cart ของ user
    let existingCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => eq(carts.userID, userId),
    });

    if (!existingCart) {
      const newCart = await dbClient
        .insert(carts)
        .values({
          userID: userId,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();
      existingCart = newCart[0];
    }

    const qtyNum = Number(qty);

    // ดึง variant
    const variant = await dbClient.query.productVariants.findFirst({
      where: (pv, { eq }) => eq(pv.id, Number(variant_id)),
    });

    if (!variant) {
      return res.status(404).json({ message: "Product variant not found" });
    }

    if (qtyNum > variant.stockQty) {
      return res.status(400).json({ message: "Not enough stock" });
    }

    const unitPriceNum = Number(variant.price);

    // หา cart item
    const existingItem = await dbClient.query.cartItems.findFirst({
      where: (cartItems, { and, eq }) =>
        and(
          eq(cartItems.cartId, existingCart.id),
          eq(cartItems.variantId, Number(variant_id))
        ),
    });

    let cartItem;
    if (existingItem) {
      const newQty = existingItem.qty + qtyNum;
      if (newQty > variant.stockQty) {
        return res.status(400).json({ message: "Not enough stock" });
      }

      const newLineTotal = new Decimal(newQty).mul(unitPriceNum).toFixed(2);

      const updatedItem = await dbClient
        .update(cartItems)
        .set({
          qty: newQty,
          lineTotal: newLineTotal,
          updatedAt: new Date(),
        })
        .where(eq(cartItems.id, existingItem.id))
        .returning();

      cartItem = updatedItem[0];
    } else {
      const newCartItem = await dbClient
        .insert(cartItems)
        .values({
          cartId: existingCart.id,
          variantId: Number(variant_id),
          qty: qtyNum,
          unitPrice: new Decimal(unitPriceNum).toFixed(2),
          lineTotal: new Decimal(qtyNum).mul(unitPriceNum).toFixed(2),
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .returning();

      cartItem = newCartItem[0];
    }

    // ลด stock_qty
    await dbClient
      .update(productVariants)
      .set({ stockQty: variant.stockQty - qtyNum })
      .where(eq(productVariants.id, variant.id));

    return res.status(201).json({
      message: existingItem
        ? "Cart item quantity updated"
        : "Cart item added successfully",
      cartItem,
      cartId: existingCart.id,
    });
  } catch (err) {
    next(err);
  }
});

/* 
===============================
= READ =
Use for: Get all cart items for the current user
Step:
1. ดึง userId จาก token
2. Find cart ของ user
3. Query cart items ทั้งหมดของ cart นั้น
===============================
*/
cartRouter.get("/items", async (req, res, next) => {
  try {
    const { user } = req as any;
    const userId = user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const userCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => eq(carts.userID, userId),
    });

    if (!userCart) {
      return res.json({ cartItems: [] });
    }

    const items = await dbClient.query.cartItems.findMany({
      where: (cartItems, { eq }) => eq(cartItems.cartId, userCart.id),
    });

    return res.json({ cartItems: items });
  } catch (err) {
    next(err);
  }
});

/* 
===============================
= UPDATE =
Use for: Update qty of specific cart item
Step:
1. ดึง userId จาก token
2. ตรวจสอบว่ามี cart ของ user นั้นไหม
3. Update qty ของ cart item ที่ตรง id
===============================
*/
cartRouter.put("/items/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user } = req as any;
    const userId = user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    if (!req.body || typeof req.body.qty === "undefined") {
      return res.status(400).json({ message: "Missing qty in request body" });
    }

    let qtyNum = Number(req.body.qty);
    if (isNaN(qtyNum) || qtyNum < 0) {
      return res.status(400).json({ message: "Invalid qty value" });
    }

    const userCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => eq(carts.userID, userId),
    });

    if (!userCart) return res.status(404).json({ message: "Cart not found" });

    const existingItem = await dbClient.query.cartItems.findFirst({
      where: (cartItems, { and, eq }) =>
        and(eq(cartItems.id, Number(id)), eq(cartItems.cartId, userCart.id)),
    });

    if (!existingItem)
      return res.status(404).json({ message: "Cart item not found" });

    // ดึง variant เพื่อเช็ค stock
    if (existingItem.variantId == null) {
      return res.status(400).json({ message: "Cart item does not have a valid variantId" });
    }
    const variant = await dbClient.query.productVariants.findFirst({
      where: (pv, { eq }) => eq(pv.id, Number(existingItem.variantId)),
    });

    if (!variant) {
      return res.status(404).json({ message: "Product variant not found" });
    }

    const stockChange = qtyNum - existingItem.qty; // + = เพิ่ม qty, - = ลด qty
    if (stockChange > variant.stockQty) {
      return res.status(400).json({ message: "Not enough stock" });
    }

    let resultItem;

    if (qtyNum === 0) {
      // ลบ item
      await dbClient.delete(cartItems).where(eq(cartItems.id, existingItem.id));

      // คืน stock
      await dbClient
        .update(productVariants)
        .set({ stockQty: variant.stockQty + existingItem.qty })
        .where(eq(productVariants.id, variant.id));

      return res.json({ message: "Cart item removed because qty is 0" });
    } else {
      // คำนวณ lineTotal ใหม่
      const lineTotal = new Decimal(existingItem.unitPrice)
        .mul(qtyNum)
        .toFixed(2);

      // update cart item
      const updatedItem = await dbClient
        .update(cartItems)
        .set({
          qty: qtyNum,
          lineTotal,
          updatedAt: new Date(),
        })
        .where(eq(cartItems.id, existingItem.id))
        .returning();

      // update stock
      await dbClient
        .update(productVariants)
        .set({ stockQty: variant.stockQty - stockChange })
        .where(eq(productVariants.id, variant.id));

      resultItem = updatedItem[0];
    }

    return res.json({
      message: "Cart item updated successfully",
      item: resultItem,
    });
  } catch (err) {
    next(err);
  }
});

/* 
===============================
= DELETE =
Use for: Delete specific cart item
Step:
1. ดึง userId จาก token
2. ตรวจสอบว่า cart นั้นเป็นของ user คนนี้จริงไหม
3. Delete cart item ที่ตรง id
===============================
*/
cartRouter.delete("/items/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { user } = req as any;
    const userId = user?.userId;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // หา cart ของ user
    const userCart = await dbClient.query.carts.findFirst({
      where: (carts, { eq }) => eq(carts.userID, userId),
    });

    if (!userCart) {
      return res.status(404).json({ message: "Cart not found" });
    }

    // หา cart item ก่อนลบ
    const existingItem = await dbClient.query.cartItems.findFirst({
      where: (cartItems, { and, eq }) =>
        and(eq(cartItems.id, Number(id)), eq(cartItems.cartId, userCart.id)),
    });

    if (!existingItem) {
      return res.status(404).json({ message: "Cart item not found" });
    }

    // คืน stock ให้ variant
    const variant = await dbClient.query.productVariants.findFirst({
      where: (pv, { eq }) => eq(pv.id, Number(existingItem.variantId)),
    });

    if (variant) {
      await dbClient
        .update(productVariants)
        .set({ stockQty: variant.stockQty + existingItem.qty })
        .where(eq(productVariants.id, variant.id));
    }

    // ลบ cart item
    await dbClient
      .delete(cartItems)
      .where(eq(cartItems.id, existingItem.id));

    return res.json({ message: "Cart item deleted successfully and stock restored" });
  } catch (err) {
    next(err);
  }
});


export { cartRouter };
