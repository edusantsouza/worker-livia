export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "POST") {
      return handleKiwifyWebhook(request, env);
    }

    return new Response("OK", { status: 200 });
  },
};

/**
 * Função principal de tratamento do webhook da Kiwify
 */
async function handleKiwifyWebhook(request, env) {
  try {
    if (!env.MAILERLITE_API_KEY) {
      return new Response("Missing MAILERLITE_API_KEY", { status: 500 });
    }
    const bodyText = await request.text();

    // Se a Kiwify enviar assinatura / segredo, aqui seria o lugar de validar.
    // Por enquanto, assumimos que o payload é confiável.
    const payload = JSON.parse(bodyText);
    const tokenExpected = env.KIWIFY_WEBHOOK_TOKEN || env.KIWIFY_TOKEN || null;
    const tokenProvided =
      request.headers.get("x-kiwify-token") ||
      request.headers.get("x-token") ||
      payload.token ||
      null;
    if (tokenExpected && tokenProvided !== tokenExpected) {
      return new Response("Unauthorized", { status: 401 });
    }

    // Estrutura esperada (ajuste conforme o formato real do webhook da Kiwify)
    const eventType = payload.event; // ex: "order.approved", "order.refunded", "checkout.abandoned"
    const data = payload.data || {};

    const email = data.customer_email || data.email;
    const fullName = data.customer_name || data.name || "";
    const productId = String(data.product_id || "");
    const productName = data.product_name || "";

    if (!email) {
      return new Response("No email in payload", { status: 400 });
    }

    // Mapeia ID de produto Kiwify para grupos/tags do MailerLite
    const productConfig = mapProduct(productId);

    // Decide o que fazer com base no tipo de evento
    switch (eventType) {
      case "order.approved":
        await handleOrderApproved({
          email,
          fullName,
          productId,
          productName,
          productConfig,
          env,
        });
        break;

      case "order.refunded":
      case "order.chargeback":
      case "order.canceled":
        await handleOrderRefundOrCancel({
          email,
          productId,
          productName,
          productConfig,
          env,
        });
        break;

      case "checkout.abandoned":
        await handleCheckoutAbandoned({
          email,
          productId,
          productName,
          productConfig,
          env,
        });
        break;

      default:
        // Se quiser logar eventos desconhecidos:
        console.log("Evento não tratado:", eventType);
        break;
    }

    return new Response("Webhook processed", { status: 200 });
  } catch (err) {
    console.error("Erro no webhook:", err);
    return new Response("Error processing webhook", { status: 500 });
  }
}

/**
 * Mapeia ID do produto Kiwify para config de grupos/tags no MailerLite
 */
function mapProduct(productId) {
  // Ajuste estas configs para os IDs reais de produto na Kiwify
  // e os nomes dos grupos/tags no MailerLite
  const mapping = {
    "12345": {
      name: "Planner Inglês 30 Dias",
      groupClient: "Clientes – Planner Inglês",
      groupCartRecovery: "Recuperação Carrinho – Planner Inglês",
      tagBought: "comprou_produto_planner_ingles",
      tagRefund: "refund_planner_ingles",
      tagAbandonedCart: "abandonou_carrinho_planner_ingles",
    },
    "67890": {
      name: "Produto Y",
      groupClient: "Clientes – Produto Y",
      groupCartRecovery: "Recuperação Carrinho – Produto Y",
      tagBought: "comprou_produto_Y",
      tagRefund: "refund_produto_Y",
      tagAbandonedCart: "abandonou_carrinho_produto_Y",
    },
  };

  return mapping[productId] || {
    name: "Produto Desconhecido",
    groupClient: "Clientes – Outros",
    groupCartRecovery: "Recuperação Carrinho – Outros",
    tagBought: "comprou_produto_desconhecido",
    tagRefund: "refund_produto_desconhecido",
    tagAbandonedCart: "abandonou_carrinho_desconhecido",
  };
}

/**
 * Trata compra aprovada
 */
async function handleOrderApproved(ctx) {
  const { email, fullName, productConfig, env } = ctx;

  // Cria/atualiza contato no MailerLite
  await upsertSubscriberInMailerLite(env, {
    email,
    name: fullName,
    groupsToAdd: [productConfig.groupClient],
    groupsToRemove: [productConfig.groupCartRecovery],
    tagsToAdd: [productConfig.tagBought],
    tagsToRemove: [productConfig.tagAbandonedCart, productConfig.tagRefund],
  });
}

/**
 * Trata refund/cancelamento
 */
async function handleOrderRefundOrCancel(ctx) {
  const { email, productConfig, env } = ctx;

  await upsertSubscriberInMailerLite(env, {
    email,
    groupsToRemove: [productConfig.groupClient],
    tagsToAdd: [productConfig.tagRefund],
  });
}

/**
 * Trata abandono de carrinho
 */
async function handleCheckoutAbandoned(ctx) {
  const { email, productConfig, env } = ctx;
  const apiKey = env.MAILERLITE_API_KEY;
  const baseUrl = "https://connect.mailerlite.com/api";
  const groupRes = await fetch(`${baseUrl}/groups?filter[name]=${encodeURIComponent(productConfig.groupClient)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (groupRes.status === 200) {
    const payload = await groupRes.json();
    const targetId = payload?.data?.[0]?.id;
    if (targetId) {
      const subRes = await fetch(`${baseUrl}/subscribers/${encodeURIComponent(email)}?include=groups`, {
        method: "GET",
        headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      });
      if (subRes.status === 200) {
        const s = await subRes.json();
        const groupsField = (s && (s.groups || (s.data && s.data.groups))) || [];
        const groupIds = Array.isArray(groupsField)
          ? groupsField.map((g) => (typeof g === "string" ? g : g.id))
          : [];
        if (groupIds.includes(targetId)) {
          return;
        }
      }
    }
  }

  await upsertSubscriberInMailerLite(env, {
    email,
    groupsToAdd: [productConfig.groupCartRecovery],
    tagsToAdd: [productConfig.tagAbandonedCart],
  });
}

/**
 * Função para criar ou atualizar subscriber no MailerLite
 */
async function upsertSubscriberInMailerLite(
  env,
  { email, name, groupsToAdd = [], groupsToRemove = [], tagsToAdd = [], tagsToRemove = [] }
) {
  const apiKey = env.MAILERLITE_API_KEY;
  const baseUrl = "https://connect.mailerlite.com/api";

  // 1. Tenta buscar o subscriber existente
  const existing = await fetch(`${baseUrl}/subscribers/${encodeURIComponent(email)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });

  let subscriberId = null;

  if (existing.status === 200) {
    const j = await existing.json();
    subscriberId = (j && (j.id || (j.data && j.data.id))) || null;
  }

  // Se não existe, cria
  if (!subscriberId) {
    const createRes = await fetch(`${baseUrl}/subscribers`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        fields: name ? { name } : {},
        groups: [],
      }),
    });

    if (createRes.status === 201 || createRes.status === 200) {
      const created = await createRes.json();
      subscriberId = (created && (created.id || (created.data && created.data.id))) || null;
    } else {
      console.error("Erro ao criar subscriber:", await createRes.text());
      return;
    }
  }

  // 2. Adicionar/remover grupos
  for (const groupName of groupsToAdd) {
    await addSubscriberToGroup(apiKey, subscriberId, groupName);
  }

  for (const groupName of groupsToRemove) {
    await removeSubscriberFromGroup(apiKey, subscriberId, groupName);
  }

  // 3. Adicionar/remover tags
  for (const tag of tagsToAdd) {
    await addTagToSubscriber(apiKey, subscriberId, tag);
  }

  for (const tag of tagsToRemove) {
    await removeTagFromSubscriber(apiKey, subscriberId, tag);
  }
}

/**
 * Helper: adiciona subscriber a grupo pelo nome (você pode otimizar usando cache de IDs de grupos)
 */
async function addSubscriberToGroup(apiKey, subscriberId, groupName) {
  const baseUrl = "https://connect.mailerlite.com/api";
  const groupId = await findGroupId(apiKey, groupName);

  if (!groupId) {
    console.error("Grupo não encontrado:", groupName);
    return;
  }

  await fetch(`${baseUrl}/groups/${groupId}/subscribers/${subscriberId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  });
}

/**
 * Helper: remove subscriber de grupo
 */
async function removeSubscriberFromGroup(apiKey, subscriberId, groupName) {
  const baseUrl = "https://connect.mailerlite.com/api";
  const groupId = await findGroupId(apiKey, groupName);

  if (!groupId) {
    console.error("Grupo não encontrado:", groupName);
    return;
  }

  await fetch(`${baseUrl}/subscribers/${subscriberId}/groups/${groupId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
}

async function findGroupId(apiKey, groupName) {
  const baseUrl = "https://connect.mailerlite.com/api";
  const res = await fetch(`${baseUrl}/groups?filter[name]=${encodeURIComponent(groupName)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status !== 200) {
    return null;
  }
  const payload = await res.json();
  return payload?.data?.[0]?.id || null;
}

/**
 * Helper: adiciona tag
 */
async function addTagToSubscriber(apiKey, subscriberId, tagName) {
  const baseUrl = "https://connect.mailerlite.com/api";

  const res = await fetch(`${baseUrl}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: tagName,
      subscribers: [subscriberId],
    }),
  });

  if (res.status !== 200 && res.status !== 201) {
    console.error("Erro ao adicionar tag:", await res.text());
  }
}

/**
 * Helper: remover tag (Mailerlite não tem um "remove tag do subscriber" tão direto em todas as versões da API.
 * Em caso de limitação, você pode apenas adicionar nova tag sem remover a antiga, ou gerir isso por segmentos.)
 */
async function removeTagFromSubscriber(apiKey, subscriberId, tagName) {
  const baseUrl = "https://connect.mailerlite.com/api";
  const listRes = await fetch(`${baseUrl}/tags`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (listRes.status !== 200) {
    return;
  }

  const tags = await listRes.json();
  const tag = tags?.data?.find((t) => t.name === tagName);
  if (!tag) {
    return;
  }

  await fetch(`${baseUrl}/tags/${tag.id}/subscribers/${subscriberId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });
}
