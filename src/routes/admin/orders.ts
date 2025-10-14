import { Router } from "express";
import { dbClient } from "../../../db/client.ts";
import {
  orders,
  orderItems,
  products,
  productVariants,
  users,
} from "../../../db/schema.ts";
import { eq } from "drizzle-orm";

const adminOrdersRouter = Router();


// adminOrdersRouter.get("/", async (req, res) => {
//   try {
//     const allOrders = await dbClient
//       .select({
//         id: orders.id,
//         status: orders.status,
//         subtotal: orders.subtotal,
//         shipping_fee: orders.shippingFee,
//         discount_total: orders.discountTotal,
//         grand_total: orders.grandTotal,
//         created_at: orders.createdAt,
//         updated_at: orders.updatedAt,
//       })
//       .from(orders)
//       .orderBy(orders.createdAt);

//     res.json(allOrders);
//   } catch (err) {
//     console.error("❌ Error fetching all orders:", err);
//     res.status(500).json({ error: "Failed to fetch all orders" });
//   }
// });


adminOrdersRouter.get("/", async (req, res) => {
  try {
    const result = await dbClient
      .select({
        id: orders.id,
        userID: orders.userID,
        status: orders.status,
        subtotal: orders.subtotal,
        shipping_fee: orders.shippingFee,
        discount_total: orders.discountTotal,
        grand_total: orders.grandTotal,
        created_at: orders.createdAt,
        updated_at: orders.updatedAt,
        customer_name: users.name,
      })
      .from(orders)
      .leftJoin(users, eq(users.userID, orders.userID)); // ✅ ใช้ eq() จาก drizzle-orm

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch orders" });
  }
});


/* ------------------ GET /api/admin/orders/:id ------------------ */
// ✅ แสดงรายละเอียดคำสั่งซื้อแต่ละอัน
adminOrdersRouter.get("/:id", async (req, res) => {
  try {
    const orderId = Number(req.params.id);

    // ดึง order พร้อม customer_name
    const order = await dbClient
      .select({
        id: orders.id,
        userID: orders.userID,
        status: orders.status,
        subtotal: orders.subtotal,
        shipping_fee: orders.shippingFee,
        discount_total: orders.discountTotal,
        grand_total: orders.grandTotal,
        created_at: orders.createdAt,
        updated_at: orders.updatedAt,
        customer_name: users.name, // join เพื่อเอาชื่อ
      })
      .from(orders)
      .leftJoin(users, eq(users.userID, orders.userID))
      .where(eq(orders.id, orderId))
      .limit(1); // ✅ limit 1

    if (order.length === 0) {
      return res.status(404).json({ message: "Order not found" });
    }

    // ดึง items
  const items = await dbClient
  .select()
  .from(orderItems)
  .where(eq(orderItems.orderId, orderId));

const snakeItems = items.map(item => ({
  id: item.id,
  name: item.name,
  shade_name: item.shadeName,
  unit_price: Number(item.unitPrice),
  qty: item.qty,
  line_total: Number(item.lineTotal),
}));

res.json({ ...order[0], items: snakeItems });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch order" });
  }
});


export default adminOrdersRouter;
