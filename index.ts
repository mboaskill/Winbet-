import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import axios from "axios";

admin.initializeApp();
const db = admin.firestore();

// Tes identifiants PayPal
const PAYPAL_CLIENT = "AZy0xwfCrpB0jSIPXW4MYalFvaSkB5tFKKAfPpdD96ZOlMcElwmMrgdnjyX06VdRujOdmx4js5t4cZNU";
const PAYPAL_SECRET = "EK6EGh9C1X7Lz8Er4dpjMiEwHYLpcUUQXzL_ivC3pMsKBa_RXHae4sVdBPTgDtnmxq6kQ8HVZovG4yDE";

// Fonction principale pour demander un retrait
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

      if (amount > total) throw new Error("Solde insuffisant");

      // Déduction intelligente
      if (amount <= montant) {
        montant -= amount;
      } else {
        const reste = amount - montant;
        montant = 0;
        gainVues = Math.max(0, gainVues - reste);
      }

      t.update(soldeRef, { montant, gainVues });

      // Paiement PayPal automatique si type = paypal
      let payoutStatus: "pending" | "sent" | "failed" = "pending";
      if (type === "paypal" && email) {
        try {
          // 1️⃣ Récupération du token PayPal
          const tokenResp = await axios.post(
            "https://api-m.paypal.com/v1/oauth2/token",
            "grant_type=client_credentials",
            {
              auth: { username: PAYPAL_CLIENT, password: PAYPAL_SECRET },
              headers: { "Content-Type": "application/x-www-form-urlencoded" }
            }
          );
          const accessToken = tokenResp.data.access_token;

          // 2️⃣ Création du payout
          const batchId = "batch_" + Date.now();
          await axios.post(
            "https://api-m.paypal.com/v1/payments/payouts",
            {
              sender_batch_header: {
                sender_batch_id: batchId,
                email_subject: "Retrait Mboa Skills"
              },
              items: [
                {
                  recipient_type: "EMAIL",
                  amount: { value: (amount / 100).toFixed(2), currency: "XAF" },
                  receiver: email,
                  note: "Retrait de votre solde",
                  sender_item_id: "item_" + Date.now()
                }
              ]
            },
            { headers: { Authorization: `Bearer ${accessToken}` } }
          );

          payoutStatus = "sent"; // paiement réussi
        } catch (err) {
          console.error("Erreur paiement PayPal:", err);
          payoutStatus = "failed"; // échec paiement
        }
      }

      // Enregistrement retrait
      const withdrawalRef = db.collection("withdrawals").doc();
      t.set(withdrawalRef, {
        uid,
        amount,
        type,
        phone: phone || null,
        email: email || null,
        status: payoutStatus,
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

// Webhook PayPal pour mise à jour du statut
export const paypalWebhook = functions.https.onRequest(async (req, res) => {
  try {
    const event = req.body;

    if (!event || !event.event_type || !event.resource) {
      return res.status(400).send("Webhook invalide");
    }

    const itemId = event.resource.sender_item_id; // id utilisé pour identifier le retrait
    const payoutStatus = event.event_type === "PAYMENT.PAYOUTS-ITEM.SUCCEEDED"
      ? "completed"
      : event.event_type === "PAYMENT.PAYOUTS-ITEM.FAILED"
      ? "failed"
      : null;

    if (!payoutStatus) return res.status(200).send("Événement ignoré");

    // Cherche le retrait correspondant dans Firestore
    const withdrawals = await db.collection("withdrawals")
      .where("status", "in", ["sent", "pending"])
      .where("createdAt", "<=", admin.firestore.Timestamp.now())
      .get();

    withdrawals.forEach(async (doc) => {
      const data = doc.data();
      if (data && data.sender_item_id === itemId) {
        const t = db.runTransaction(async (tran) => {
          tran.update(doc.ref, { status: payoutStatus });

          // Si échec, recréditer le solde
          if (payoutStatus === "failed") {
            const soldeRef = db.collection("soldes").doc(data.uid);
            const soldeSnap = await tran.get(soldeRef);
            if (soldeSnap.exists) {
              let soldeData = soldeSnap.data() || {};
              let montant = soldeData.montant || 0;
              let gainVues = soldeData.gainVues || 0;
              montant += data.amount; // recréditer sur montant
              tran.update(soldeRef, { montant, gainVues });
            }
          }
        });
      }
    });

    return res.status(200).send("Webhook traité");
  } catch (err) {
    console.error("Erreur Webhook PayPal:", err);
    return res.status(500).send("Erreur serveur");
  }
});