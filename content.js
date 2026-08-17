console.log("[Aurex Ext] Content script loaded.");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "dom_action") {
    const { command, value } = message.payload;
    
    try {
      // Cliques e digitação NÃO passam por aqui: são feitos via CDP no
      // background.js, que dispara eventos reais de mouse/teclado.
      if (command === "read_dom") {
        // Captura abrangente do conteúdo da página
        const pageInfo = {
          title: document.title,
          url: window.location.href,
          meta_description: document.querySelector('meta[name="description"]')?.content || "",
          h1: Array.from(document.querySelectorAll('h1')).map(el => el.innerText.trim()).filter(Boolean),
          h2: Array.from(document.querySelectorAll('h2')).map(el => el.innerText.trim()).filter(Boolean),
          h3: Array.from(document.querySelectorAll('h3')).map(el => el.innerText.trim()).filter(Boolean),
          links: Array.from(document.querySelectorAll('a[href]')).slice(0, 30).map(a => ({
            text: a.innerText.trim().substring(0, 80),
            href: a.href
          })).filter(l => l.text),
          buttons: Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"]')).slice(0, 20).map(b => ({
            text: (b.innerText || b.value || b.getAttribute('aria-label') || '').trim().substring(0, 80),
            id: b.id || null,
            class: b.className?.toString().substring(0, 60) || null
          })).filter(b => b.text),
          inputs: Array.from(document.querySelectorAll('input, textarea, select')).slice(0, 20).map(inp => ({
            type: inp.type || inp.tagName.toLowerCase(),
            name: inp.name || null,
            id: inp.id || null,
            placeholder: inp.placeholder || null,
            value: inp.value?.substring(0, 50) || null
          })),
          images: Array.from(document.querySelectorAll('img[alt]')).slice(0, 15).map(img => ({
            alt: img.alt.substring(0, 80),
            src: img.src?.substring(0, 120)
          })).filter(i => i.alt),
          text_content: Array.from(document.querySelectorAll('p, h1, h2, h3, article, .content, .materia, .texto')).slice(0, 40).map(el => el.innerText.trim()).filter(t => t.length > 30),
          tables: Array.from(document.querySelectorAll('table')).slice(0, 5).map(table => {
            const rows = Array.from(table.querySelectorAll('tr')).slice(0, 10);
            return rows.map(row => 
              Array.from(row.querySelectorAll('th, td')).map(cell => cell.innerText.trim().substring(0, 50))
            );
          })
        };
        // Se a página for um iframe isolado de anúncio ou estiver vazia, text_content pode ser fallback pro body
        if (pageInfo.text_content.length === 0) {
           pageInfo.visible_text = document.body.innerText.substring(0, 3000);
        }
        sendResponse({ success: true, data: pageInfo });
      }
      else if (command === "scroll") {
        const amount = parseInt(value) || 500;
        window.scrollBy(0, amount);
        sendResponse({ success: true, message: `Scrolled ${amount}px down` });
      }
      else if (command === "get_element_text") {
        const el = document.querySelector(message.payload.selector);
        if (el) {
          sendResponse({ success: true, data: el.innerText.trim() });
        } else {
          sendResponse({ success: false, error: "Element not found" });
        }
      }
      else if (command === "navigate") {
        window.location.href = value;
        sendResponse({ success: true, message: `Navigating to: ${value}` });
      }
      else if (command === "search_web") {
        window.location.href = `https://www.google.com/search?q=${encodeURIComponent(value)}`;
        sendResponse({ success: true, message: `Pesquisando no Google por: ${value}` });
      }
      else {
        sendResponse({ success: false, error: "Unknown command: " + command });
      }
    } catch (e) {
      sendResponse({ success: false, error: e.toString() });
    }
  }
  
  return true;
});
