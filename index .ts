import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

export const requestWithdrawal = functions.https.onRequest(async (req, res) => {
  try {
    const { uid, amount, type, phone, email } = req.body;

    if (!uid || !amount || !type) {
      return res.status(400).json({ success: false, message: "Données invalides" });
    }

    if (amount < 5000) {
      return res.json({ success: false, message: "Minimum 5000 XAF" });
    }

    const soldeRef = db.collection("soldes").doc(uid);

    await db.runTransaction(async (t) => {
      const snap = await t.get(soldeRef);

      if (!snap.exists) throw new Error("Solde introuvable");

      let data = snap.data() || {};
      let montant = data.montant || 0;
      let gainVues = data.gainVues || 0;

      let total = montant + gainVues;

      if (amount > total) {
        throw new Error("Solde insuffisant");
      }

      // 🔥 Déduction intelligente
      if (amount <= montant) {
        montant -= amount;
      } else {
        const reste = amount - montant;
        montant = 0;
        gainVues = Math.max(0, gainVues - reste);
      }

      t.update(soldeRef, { montant, gainVues });

      // 🔥 Enregistrement retrait
      t.set(db.collection("withdrawals").doc(), {
        uid,
        amount,
        type, // paypal ou mobile
        phone: phone || null,
        email: email || null,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return res.json({ success: true });

  } catch (err: any) {
    console.error(err);
    return res.json({
      success: false,
      message: err.message || "Erreur serveur"
    });
  }
});