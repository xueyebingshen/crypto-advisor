// State Variables
console.log("AI Crypto Trend Advisor - V3.14 Loaded successfully. Cloud Database Sync active.");
let activeToken = 'BTC';
let currentPrice = 61000; // Initialize with sensible default immediately
let fngValue = 50;
let fngClassification = 'Neutral';
let chartInstance = null;
let cnhRate = 7.25; // Default CNH rate for CNY conversion
let officialUSDCNH = 7.24;
let usdtCnhPrice = null;

// Mock Trading Portfolio State
let portfolio = {
  lastSyncTime: Date.now(),
  BTC: { balance: 2000.0, pendingOrders: [], activePositions: [], history: [] },
  ETH: { balance: 2000.0, pendingOrders: [], activePositions: [], history: [] }
};
let selectedSetupLetter = null; // For modal tracking ('A', 'B', 'C', 'D')
let btcPrice = 0;
let ethPrice = 0;
let isOfflineSyncCompleted = false;
let isFirstPriceLoad = true;
let resetCounter = 0;
let backtest = null;
let activeAccountId = 'manual';

// Supabase Cloud Configuration
const SUPABASE_URL = "https://zhnpmuyryherlzrrfumk.supabase.co";
const SUPABASE_KEY = "sb_publishable_OJar6H5OV0Qka4UuA0VLzA_U4Q5RzXf";
let supabaseClient = null;

if (typeof supabase !== 'undefined') {
  try {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("[Supabase Client] Initialized successfully.");
  } catch (e) {
    console.error("[Supabase Client] Initialization failed:", e);
  }
} else {
  console.warn("[Supabase Client] Library not loaded. Cloud sync is disabled.");
}

let syncDebounceTimer = null;
let isSyncingToSupabase = false;
let hasPendingSync = false;

function syncStateToSupabase() {
  if (!supabaseClient) return;
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  
  syncDebounceTimer = setTimeout(async () => {
    if (isSyncingToSupabase) {
      hasPendingSync = true;
      return;
    }
    
    isSyncingToSupabase = true;
    hasPendingSync = false;
    
    try {
      const statusSpan = document.querySelector('.live-pulse span');
      let originalText = "";
      if (statusSpan) {
        originalText = statusSpan.innerText;
        if (!statusSpan.innerText.includes("同步")) {
          statusSpan.innerText = "正在同步云端数据...";
          statusSpan.style.color = "var(--color-primary)";
        }
      }

      const { error } = await supabaseClient
        .from('crypto_advisor_state')
        .upsert({
          id: 'default',
          portfolio: portfolio,
          backtest: backtest,
          updated_at: new Date().toISOString()
        });
        
      if (error) {
        console.warn("[Supabase Sync] Upload failed:", error.message);
        if (statusSpan) {
          statusSpan.innerText = "云端同步失败 (已用本地缓存)";
          statusSpan.style.color = "var(--color-warning)";
          setTimeout(() => {
            if (statusSpan.innerText.includes("同步")) {
              statusSpan.innerText = originalText;
              statusSpan.style.color = "var(--color-success)";
            }
          }, 3000);
        }
      } else {
        console.log("[Supabase Sync] Upload succeeded.");
        if (statusSpan) {
          statusSpan.innerText = "云端数据已同步";
          statusSpan.style.color = "var(--color-success)";
          setTimeout(() => {
            if (statusSpan.innerText.includes("云端")) {
              statusSpan.innerText = originalText;
              statusSpan.style.color = "var(--color-success)";
            }
          }, 2000);
        }
      }
    } catch (e) {
      console.warn("[Supabase Sync] Network error:", e);
    } finally {
      isSyncingToSupabase = false;
      if (hasPendingSync) {
        syncStateToSupabase();
      }
    }
  }, 200);
}


async function loadStateFromSupabase() {
  if (!supabaseClient) return false;
  
  try {
    const { data, error } = await supabaseClient
      .from('crypto_advisor_state')
      .select('portfolio, backtest')
      .eq('id', 'default')
      .single();
      
    if (error) {
      console.warn("[Supabase Load] Fetch failed:", error.message);
      return false;
    }
    
    if (data && data.portfolio && data.backtest) {
      portfolio = data.portfolio;
      backtest = data.backtest;
      
      // Update local storage backup
      localStorage.setItem('crypto_advisor_portfolio', JSON.stringify(portfolio));
      localStorage.setItem('crypto_advisor_backtest', JSON.stringify(backtest));
      
      console.log("[Supabase Load] Cloud state loaded successfully.");
      return true;
    }
  } catch (e) {
    console.warn("[Supabase Load] Fetch failed (network error):", e);
  }
  return false;
}

// Fetch helper with timeout (GFW Protection)
async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 1500 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}

// Initial setup on page load
window.addEventListener('DOMContentLoaded', async () => {
  // Load portfolio from LocalStorage first (instant paint)
  loadPortfolio();
  loadBacktest();

  // Load persisted active account and token
  const savedActiveToken = localStorage.getItem('crypto_advisor_active_token') || 'BTC';
  const savedActiveAccount = localStorage.getItem('crypto_advisor_active_account') || 'manual';
  
  // Set activeToken to null temporarily so switchToken triggers and initializes UI
  activeToken = null;
  switchToken(savedActiveToken);
  switchActiveAccount(savedActiveAccount);
  
  // Fetch initial API data
  fetchLivePrice();
  fetchFearAndGreed();
  fetchAllLiveMetrics(activeToken);
  
  // Start intervals for live updates
  setInterval(fetchLivePrice, 5000); // Ticker price updates every 5s
  setInterval(fetchFearAndGreed, 3600000); // F&G updates hourly (since it changes daily)
  setInterval(() => {
    fetchAllLiveMetrics(activeToken);
  }, 60000); // Sync all live metrics every 60s
  
  // Save portfolio and backtest state and update UI every 5s
  setInterval(() => {
    if (portfolio) {
      portfolio.lastSyncTime = Date.now();
      savePortfolio();
    }
    if (backtest) {
      backtest.lastSyncTime = Date.now();
      saveBacktest();
      renderBacktestComparisonTable();
    }
    updateRealtimeUnrealizedPnL();
  }, 5000);

  // Background Cloud Sync Load:
  // Fetch from Supabase and if newer/valid state exists, overwrite local and update UI
  try {
    const cloudLoaded = await loadStateFromSupabase();
    if (cloudLoaded) {
      // Re-trigger view states update to reflect cloud data
      switchToken(savedActiveToken);
      switchActiveAccount(savedActiveAccount);
      renderBacktestComparisonTable();
      renderPortfolioUI();
      updateRealtimeUnrealizedPnL();
      // Re-run offline backfill if cloud has different sync timestamp
      triggerOfflineBackfill();
    }
  } catch (e) {
    console.warn("Background cloud load failed, keeping local storage.", e);
  }
});

// Switch between BTC and ETH
function switchToken(token) {
  if (activeToken === token) return;
  activeToken = token;
  localStorage.setItem('crypto_advisor_active_token', token);
  
  // Update button active state
  document.getElementById('btn-btc').classList.toggle('active', token === 'BTC');
  document.getElementById('btn-eth').classList.toggle('active', token === 'ETH');
  
  // Reset input placeholders and default values
  resetDefaults(token);
  
  // Re-fetch price immediately
  fetchLivePrice();
  fetchAllLiveMetrics(token);
}

// Reset Default Peak Values
function resetDefaults(token) {
  const input1 = document.getElementById('input-peak-1');
  const input2 = document.getElementById('input-peak-2');
  const label1 = document.getElementById('label-peak-1');
  const label2 = document.getElementById('label-peak-2');

  const inputShort1 = document.getElementById('input-short-peak-1');
  const inputShort2 = document.getElementById('input-short-peak-2');
  const labelShort1 = document.getElementById('label-short-peak-1');
  const labelShort2 = document.getElementById('label-short-peak-2');

  // Set default price immediately so calculations can run without waiting for API timeouts
  if (token === 'BTC') {
    currentPrice = btcPrice > 0 ? btcPrice : 61000;
  } else {
    currentPrice = ethPrice > 0 ? ethPrice : 1800;
  }

  if (token === 'BTC') {
    input1.value = Math.round(currentPrice * 0.967);
    input2.value = Math.round(currentPrice * 0.947);
    input1.placeholder = "例如: " + input1.value;
    input2.placeholder = "例如: " + input2.value;
    label1.innerText = "BTC 多头第1爆仓峰值";
    label2.innerText = "BTC 多头第2爆仓极限";

    if (inputShort1) {
      inputShort1.value = Math.round(currentPrice * 1.057);
      inputShort1.placeholder = "例如: " + inputShort1.value;
      labelShort1.innerText = "BTC 空头第1爆仓峰值";
    }
    if (inputShort2) {
      inputShort2.value = Math.round(currentPrice * 1.078);
      inputShort2.placeholder = "例如: " + inputShort2.value;
      labelShort2.innerText = "BTC 空头第2爆仓极限";
    }
  } else {
    input1.value = Math.round(currentPrice * 0.967);
    input2.value = Math.round(currentPrice * 0.947);
    input1.placeholder = "例如: " + input1.value;
    input2.placeholder = "例如: " + input2.value;
    label1.innerText = "ETH 多头第1爆仓峰值";
    label2.innerText = "ETH 多头第2爆仓极限";

    if (inputShort1) {
      inputShort1.value = Math.round(currentPrice * 1.057);
      inputShort1.placeholder = "例如: " + inputShort1.value;
      labelShort1.innerText = "ETH 空头第1爆仓峰值";
    }
    if (inputShort2) {
      inputShort2.value = Math.round(currentPrice * 1.078);
      inputShort2.placeholder = "例如: " + inputShort2.value;
      labelShort2.innerText = "ETH 空头第2爆仓极限";
    }
  }
  
  // Trigger recalculation and chart update
  setTimeout(() => {
    updateChart();
    runCalculator();
  }, 100);
}

// Fetch Live Ticker Price from Binance & Fallback APIs
async function fetchPriceFromAPI(symbol) {
  // Try Primary: Binance Vision Sandbox (CORS-enabled & highly accessible in China)
  try {
    const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${symbol}USDT`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      return parseFloat(data.price);
    }
  } catch (e) {
    console.warn("Primary Binance Vision API failed, trying Backup 1...", e);
  }

  // Try Backup 1: OKX API (accessible & CORS-enabled)
  try {
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/market/ticker?instId=${symbol}-USDT`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      if (data && data.data && data.data.length > 0) {
        return parseFloat(data.data[0].last);
      }
    }
  } catch (e) {
    console.warn("OKX API failed, trying HTX...", e);
  }

  // Try Backup 2: HTX (Huobi) API (CORS-enabled)
  try {
    const response = await fetchWithTimeout(`https://api.huobi.pro/market/detail/merged?symbol=${symbol.toLowerCase()}usdt`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      if (data && data.tick) {
        return parseFloat(data.tick.close);
      }
    }
  } catch (e) {
    console.warn("HTX API failed, trying Binance Spot...", e);
  }

  // Try Backup 3: Binance API (might fail with CORS/451)
  try {
    const response = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      return parseFloat(data.price);
    }
  } catch (e) {
    console.warn("Backup Binance API failed, trying API3...", e);
  }

  // Try Backup 4: Binance API 3 (might fail with CORS/451)
  try {
    const response = await fetchWithTimeout(`https://api3.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      return parseFloat(data.price);
    }
  } catch (e) {
    console.warn("Backup Binance API 3 failed.", e);
  }

  return null;
}

async function fetchLivePrice() {
  // Fetch both BTC and ETH prices to run background matchmaking for all active orders
  const btc = await fetchPriceFromAPI('BTC');
  if (btc) btcPrice = btc;
  
  const eth = await fetchPriceFromAPI('ETH');
  if (eth) ethPrice = eth;
  
  const symbol = activeToken === 'BTC' ? 'BTC' : 'ETH';
  const price = symbol === 'BTC' ? btc : eth;
  
  const statusSpan = document.querySelector('.live-pulse span');
  const pulseDot = document.querySelector('.pulse-dot');
  const editBtn = document.getElementById('btn-edit-price');
  
  if (price) {
    currentPrice = price;
    statusSpan.innerText = "API 实时连接";
    statusSpan.style.color = "var(--color-success)";
    pulseDot.style.background = "var(--color-success)";
    editBtn.style.color = "var(--color-text-muted)";
  } else {
    // If all APIs fail, use a fallback default value
    if (currentPrice === 0) {
      currentPrice = symbol === 'BTC' ? 61000 : 1800;
    }
    statusSpan.innerText = "API 连接失败 (已用兜底价)";
    statusSpan.style.color = "var(--color-warning)";
    pulseDot.style.background = "var(--color-warning)";
    editBtn.style.color = "var(--color-warning)";
  }
  
  const priceDisplay = document.getElementById('price-display');
  priceDisplay.innerText = `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  // Smooth pulse color highlight on change
  priceDisplay.style.color = '#ffffff';
  setTimeout(() => {
    priceDisplay.style.color = 'var(--color-primary)';
  }, 200);
  
  // If this is the first successful price fetch, reset input defaults to use the actual live price
  if (price && isFirstPriceLoad) {
    isFirstPriceLoad = false;
    resetDefaults(activeToken);
  } else {
    runCalculator();
    updateChart();
  }
  
  // Matchmake orders for both tokens
  if (btcPrice > 0 || ethPrice > 0) {
    matchmakeAllTokens();
  }
  
  // Run one-time offline backfill check when initial price feed is loaded
  // IMPORTANT: isOfflineSyncCompleted must only be set TRUE *after* the backfill
  // completes, so syncBacktestOrders does not overwrite yesterday's locked order
  // prices before the historical replay engine has a chance to match them.
  if (!isOfflineSyncCompleted && (btcPrice > 0 || ethPrice > 0)) {
    setTimeout(async () => {
      await triggerOfflineBackfill();
      isOfflineSyncCompleted = true;
      // Now that history is replayed, sync orders to current levels
      syncBacktestOrders();
    }, 500);
  }
}

// Prompt User for Manual Price Input
function promptManualPrice() {
  const symbol = activeToken === 'BTC' ? 'BTC' : 'ETH';
  const val = prompt(`请输入手动的 ${symbol} 指数价格 (当前显示: $${currentPrice}):`, currentPrice);
  const parsedVal = parseFloat(val);
  
  if (!isNaN(parsedVal) && parsedVal > 0) {
    currentPrice = parsedVal;
    
    // Update local matchmaking prices immediately
    if (activeToken === 'BTC') btcPrice = parsedVal;
    if (activeToken === 'ETH') ethPrice = parsedVal;
    
    // Update display
    const priceDisplay = document.getElementById('price-display');
    priceDisplay.innerText = `$${currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    
    // Mark as manually entered
    const statusSpan = document.querySelector('.live-pulse span');
    const pulseDot = document.querySelector('.pulse-dot');
    statusSpan.innerText = "已启用手动输入价格";
    statusSpan.style.color = "var(--color-primary)";
    pulseDot.style.background = "var(--color-primary)";
    
    // Trigger updates
    runCalculator();
    updateChart();
    
    // Immediately matchmake positions against manual price override
    matchmakeAllTokens();
  }
}

// Fetch Fear and Greed Index
async function fetchFearAndGreed() {
  try {
    const response = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', { timeout: 2000 });
    if (!response.ok) throw new Error('F&G fetch failed');
    const data = await response.json();
    
    fngValue = parseInt(data.data[0].value);
    fngClassification = data.data[0].value_classification;
    updateFngUI(false);
  } catch (error) {
    console.warn('Error fetching Fear & Greed, using fallback:', error);
    // Use fallback values (since current index was 12 in the screenshot)
    fngValue = 12;
    fngClassification = 'Extreme Fear';
    updateFngUI(true);
  }
}

function updateFngUI(isFallback) {
  // Translate classification
  let cnClass = '';
  let colorClass = '';
  switch (fngClassification) {
    case 'Extreme Fear':
      cnClass = '极度恐慌';
      colorClass = 'var(--color-danger)';
      break;
    case 'Fear':
      cnClass = '恐慌';
      colorClass = 'var(--color-warning)';
      break;
    case 'Neutral':
      cnClass = '中性';
      colorClass = 'var(--color-primary)';
      break;
    case 'Greed':
      cnClass = '贪婪';
      colorClass = 'var(--color-success)';
      break;
    case 'Extreme Greed':
      cnClass = '极度贪婪';
      colorClass = 'var(--color-success)';
      break;
    default:
      cnClass = fngClassification;
      colorClass = 'var(--color-text-main)';
  }
  
  const fngDisplay = document.getElementById('fng-display');
  fngDisplay.innerText = fngValue;
  fngDisplay.style.color = colorClass;
  
  const fngStatus = document.getElementById('fng-status');
  fngStatus.innerText = `当前情绪: ${cnClass}${isFallback ? ' (网络受限，已用兜底值)' : ''}`;
  fngStatus.style.color = colorClass;
}

// Render and Update Liquidation Chart
function updateChart() {
  // Check if Chart.js is loaded (GFW Protection)
  if (typeof Chart === 'undefined') {
    console.warn("Chart.js is not loaded. Skipping chart rendering.");
    const container = document.querySelector('.chart-container');
    if (container) {
      container.innerHTML = `<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--color-warning); font-size:0.85rem; border:1px dashed var(--panel-border); border-radius:12px; padding:1.5rem; text-align:center; background:rgba(0,0,0,0.25);">
        <div>
          <i class="fa-solid fa-triangle-exclamation" style="margin-bottom:0.8rem; font-size:1.5rem; color:var(--color-warning);"></i>
          <p>图表组件加载失败 (由于CDN网络受限)</p>
          <p style="font-size:0.75rem; color:var(--color-text-muted); margin-top:0.3rem;">但右侧的 AI 诊断、均线评估及安全挂单计算功能仍然 100% 正常工作，请放心使用！</p>
        </div>
      </div>`;
    }
    return;
  }

  const peak1 = parseFloat(document.getElementById('input-peak-1').value) || 0;
  const peak2 = parseFloat(document.getElementById('input-peak-2').value) || 0;
  const shortPeak1 = parseFloat(document.getElementById('input-short-peak-1').value) || 0;
  const shortPeak2 = parseFloat(document.getElementById('input-short-peak-2').value) || 0;
  
  if (!currentPrice || !peak1 || !peak2 || !shortPeak1 || !shortPeak2) return;
  
  const ctx = document.getElementById('liquidation-chart').getContext('2d');
  
  // Generate mock liquidation map values based on current price and inputs
  // We'll generate 40 bars distributed around current price
  const steps = 40;
  const range = activeToken === 'BTC' ? 3000 : 200; // Price range on either side
  const startPrice = currentPrice - range;
  const stepSize = (range * 2) / steps;
  
  const labels = [];
  const longStrengths = [];
  const shortStrengths = [];
  
  for (let i = 0; i <= steps; i++) {
    const p = Math.round(startPrice + i * stepSize);
    labels.push(p);
    
    let longVal = 0;
    let shortVal = 0;
    
    // Draw columns on the left (Long liquidations below current price)
    if (p < currentPrice) {
      // Create peak clusters around user-defined peaks
      const distToPeak1 = Math.abs(p - peak1);
      const distToPeak2 = Math.abs(p - peak2);
      
      if (distToPeak1 < stepSize * 1.5) {
        longVal = 70 + (1.5 - distToPeak1/stepSize) * 40; // Peak 1
      } else if (distToPeak2 < stepSize * 1.5) {
        longVal = 55 + (1.5 - distToPeak2/stepSize) * 30; // Peak 2
      } else {
        // Random background noise
        longVal = 5 + Math.random() * 15;
      }
      
      // Gradually decrease columns down to far left
      if (p < peak2 - stepSize * 3) {
        longVal = longVal * 0.2;
      }
    } 
    // Draw columns on the right (Short liquidations above current price)
    else if (p > currentPrice) {
      // Create peak clusters around user-defined short peaks
      const distToShortPeak1 = Math.abs(p - shortPeak1);
      const distToShortPeak2 = Math.abs(p - shortPeak2);
      
      if (distToShortPeak1 < stepSize * 1.5) {
        shortVal = 70 + (1.5 - distToShortPeak1/stepSize) * 40; // Short Peak 1
      } else if (distToShortPeak2 < stepSize * 1.5) {
        shortVal = 55 + (1.5 - distToShortPeak2/stepSize) * 30; // Short Peak 2
      } else {
        // Random background noise
        shortVal = 5 + Math.random() * 15;
      }
      
      // Gradually decrease columns above far right
      if (p > shortPeak2 + stepSize * 3) {
        shortVal = shortVal * 0.2;
      }
    }
    
    longStrengths.push(longVal);
    shortStrengths.push(shortVal);
  }
  
  const chartData = {
    labels: labels,
    datasets: [
      {
        label: '多单清算强度 (Longs)',
        data: longStrengths,
        backgroundColor: 'rgba(0, 230, 118, 0.75)', // Vivid Green (matching --color-success)
        borderColor: 'rgba(0, 230, 118, 1)',
        borderWidth: 1,
        barPercentage: 0.8,
      },
      {
        label: '空单清算强度 (Shorts)',
        data: shortStrengths,
        backgroundColor: 'rgba(255, 23, 68, 0.75)', // Vivid Red (matching --color-danger)
        borderColor: 'rgba(255, 23, 68, 1)',
        borderWidth: 1,
        barPercentage: 0.8,
      }
    ]
  };
  
  if (chartInstance) {
    chartInstance.destroy();
  }
  
  chartInstance = new Chart(ctx, {
    type: 'bar',
    data: chartData,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: '#8b8fba',
            maxTicksLimit: 10,
            font: { size: 9 }
          }
        },
        y: {
          grid: { color: 'rgba(255, 255, 255, 0.05)' },
          ticks: { display: false } // Hide strength scale numbers for cleaner look
        }
      },
      plugins: {
        legend: { display: false }, // Custom legend styled in HTML
        tooltip: {
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${Math.round(context.raw)}万强度`;
            }
          }
        }
      }
    }
  });
}

// AI Calculator Calculation Logic
function runCalculator() {
  const peak1 = parseFloat(document.getElementById('input-peak-1').value) || 0;
  const peak2 = parseFloat(document.getElementById('input-peak-2').value) || 0;
  const shortPeak1 = parseFloat(document.getElementById('input-short-peak-1').value) || 0;
  const shortPeak2 = parseFloat(document.getElementById('input-short-peak-2').value) || 0;

  const leverage = parseInt(document.getElementById('select-leverage').value);
  const emaPos = document.getElementById('select-ema').value;
  const funding = document.getElementById('select-funding').value;
  const allocation = document.getElementById('select-allocation').value;
  
  // Advanced Selectors
  const dxy = document.getElementById('select-dxy').value;
  const etf = document.getElementById('select-etf').value;
  const pattern = document.getElementById('select-pattern').value;
  const walls = document.getElementById('select-walls').value;
  
  if (!currentPrice || !peak1 || !peak2 || !shortPeak1 || !shortPeak2) return;
  
  // 1. Calculate Safe entry/resistance zones
  // Safety offsets grow wider based on leverage
  let l1Offset = 0.007; // 0.7% default offset
  let l2Offset = 0.012; // 1.2% default offset
  
  if (leverage >= 5) {
    l1Offset = 0.01;
    l2Offset = 0.018;
  }
  
  // Support prices (below long liquidation peaks)
  const level1Price = Math.round(peak1 * (1 - l1Offset));
  const level2Price = Math.round(peak2 * (1 - l2Offset));
  
  // Resistance prices (above short liquidation peaks, where short squeeze buying exhausts)
  const res1Price = Math.round(shortPeak1 * (1 + l1Offset));
  const res2Price = Math.round(shortPeak2 * (1 + l2Offset));
  
  document.getElementById('level-1-price').innerText = `$${level1Price.toLocaleString()}`;
  document.getElementById('level-2-price').innerText = `$${level2Price.toLocaleString()}`;
  
  const res1Elem = document.getElementById('res-1-price');
  const res2Elem = document.getElementById('res-2-price');
  if (res1Elem) res1Elem.innerText = `$${res1Price.toLocaleString()}`;
  if (res2Elem) res2Elem.innerText = `$${res2Price.toLocaleString()}`;
  
  // 1b. Calculate CNY Valuations & USDT Premium
  const cnyPrice = currentPrice * cnhRate;
  const cnySupport = level2Price * cnhRate;
  const cnyResistance = res2Price * cnhRate;

  const cnyPriceDisplay = document.getElementById('cny-price-display');
  const cnySupportDisplay = document.getElementById('cny-support-display');
  const cnyResistanceDisplay = document.getElementById('cny-resistance-display');

  if (cnyPriceDisplay) cnyPriceDisplay.innerText = `${Math.round(cnyPrice).toLocaleString()} CNY`;
  if (cnySupportDisplay) cnySupportDisplay.innerText = `${Math.round(cnySupport).toLocaleString()} CNY`;
  if (cnyResistanceDisplay) cnyResistanceDisplay.innerText = `${Math.round(cnyResistance).toLocaleString()} CNY`;

  // Calculate USDT Premium dynamically
  let premium = 0.0;
  if (usdtCnhPrice && officialUSDCNH) {
    premium = ((usdtCnhPrice - officialUSDCNH) / officialUSDCNH) * 100;
  } else {
    // Estimate premium based on Fear & Greed index (psychological buying power in China)
    premium = ((fngValue - 50) * 0.015);
  }
  const premiumDisplay = document.getElementById('usdt-premium-display');
  if (premiumDisplay) {
    const isPositive = premium >= 0;
    premiumDisplay.innerText = `${isPositive ? '+' : ''}${premium.toFixed(2)}% (${isPositive ? '正溢价 - 资金流入' : '折价 - 资金流出'})`;
    premiumDisplay.style.color = isPositive ? 'var(--color-success)' : 'var(--color-danger)';
  }
  
  // 1c. Calculate Trading Playbook values dynamically
  // Setup A: Left Side Buy (DCA from Level 2 to Level 1)
  const setupAEntry = `$${level2Price.toLocaleString()} - $${level1Price.toLocaleString()}`;
  const setupASL = Math.round(level2Price * 0.988);
  const setupATP = Math.round(Math.max(currentPrice * 1.025, level1Price * 1.05));
  
  document.getElementById('setup-a-entry').innerText = setupAEntry;
  document.getElementById('setup-a-sl').innerText = `$${setupASL.toLocaleString()}`;
  document.getElementById('setup-a-tp').innerText = `$${setupATP.toLocaleString()}`;

  // Setup B: Right Side Breakout (Above local resistance)
  const setupBEntry = Math.round(currentPrice * 1.01);
  const setupBSL = Math.round(currentPrice * 0.999);
  const setupBTP = Math.round(currentPrice * 1.026);

  document.getElementById('setup-b-entry').innerText = `$${setupBEntry.toLocaleString()}`;
  document.getElementById('setup-b-sl').innerText = `$${setupBSL.toLocaleString()}`;
  document.getElementById('setup-b-tp').innerText = `$${setupBTP.toLocaleString()}`;
  
  // Setup C: Left Side Short (DCA from Short Peak 1 to Short Peak 2)
  const setupCEntry = `$${Math.round(shortPeak1).toLocaleString()} - $${Math.round(shortPeak2).toLocaleString()}`;
  const setupCSL = Math.round(shortPeak2 * 1.012);
  const setupCTP = Math.round(Math.min(currentPrice * 0.975, peak1 * 0.95));

  document.getElementById('setup-c-entry').innerText = setupCEntry;
  document.getElementById('setup-c-sl').innerText = `$${setupCSL.toLocaleString()}`;
  document.getElementById('setup-c-tp').innerText = `$${setupCTP.toLocaleString()}`;

  // Setup D: Right Side Breakdown
  const setupDEntry = Math.round(currentPrice * 0.99);
  const setupDSL = Math.round(currentPrice * 1.001);
  const setupDTP = Math.round(currentPrice * 0.974);

  document.getElementById('setup-d-entry').innerText = `$${setupDEntry.toLocaleString()}`;
  document.getElementById('setup-d-sl').innerText = `$${setupDSL.toLocaleString()}`;
  document.getElementById('setup-d-tp').innerText = `$${setupDTP.toLocaleString()}`;

  // 2. Compute AI Rebound Probability Score (Long)
  let longScore = 50; // Neutral starting base
  
  // F&G Factor (Fear is good for rebound)
  if (fngValue < 20) longScore += 20; // Extreme Fear
  else if (fngValue < 40) longScore += 10; // Fear
  else if (fngValue > 80) longScore -= 15; // Extreme Greed
  
  // EMA Position Factor
  if (emaPos === 'above') longScore += 15; // Bullish momentum
  else longScore -= 10; // Bearish trend
  
  // Funding Rate Factor
  if (funding === 'negative') longScore += 15; // Shorts crowded
  else if (funding === 'high') longScore -= 15; // Longs crowded
  
  // Leverage safety rating
  if (leverage <= 2) longScore += 10;
  else if (leverage >= 10) longScore -= 20;
  
  // Allocation
  if (allocation === 'dca') longScore += 5;
  
  // Advanced Factors:
  // DXY Index (DXY falling is good for risk assets)
  if (dxy === 'falling') longScore += 8;
  else longScore -= 8;
  
  // U.S. ETF Flows
  if (etf === 'inflow') longScore += 8;
  else longScore -= 8;
  
  // Candlestick Pattern
  if (pattern === 'yes') longScore += 12;
  else longScore -= 5;
  
  // Order Book Walls
  if (walls === 'buy-wall') longScore += 8;
  
  // Bound score
  longScore = Math.max(5, Math.min(99, longScore));
  
  // 3. Compute AI Resistance/Retracement Probability Score (Short)
  let shortScore = 50; // Neutral starting base
  
  // F&G Factor (Greed is good for shorting)
  if (fngValue > 80) shortScore += 20; // Extreme Greed
  else if (fngValue > 60) shortScore += 10; // Greed
  else if (fngValue < 20) shortScore -= 20; // Extreme Fear
  else if (fngValue < 40) shortScore -= 10; // Fear
  
  // EMA Position Factor
  if (emaPos === 'below') shortScore += 15; // Bearish trend
  else shortScore -= 10; // Bullish trend
  
  // Funding Rate Factor
  if (funding === 'high') shortScore += 20; // Longs crowded
  else if (funding === 'negative') shortScore -= 15; // Shorts crowded
  
  // Leverage safety rating
  if (leverage <= 2) shortScore += 10;
  else if (leverage >= 10) shortScore -= 20;
  
  // Allocation
  if (allocation === 'dca') shortScore += 5;
  
  // Advanced Factors:
  // DXY Index (DXY rising is good for shorting)
  if (dxy === 'rising') shortScore += 8;
  else shortScore -= 8;
  
  // U.S. ETF Flows
  if (etf === 'outflow') shortScore += 8;
  else shortScore -= 8;
  
  // Candlestick Pattern (Shorting prefers no bottom patterns)
  if (pattern === 'no') shortScore += 8;
  else shortScore -= 12;
  
  // Order Book Walls (Shorting prefers neutral walls)
  if (walls === 'neutral') shortScore += 8;
  else shortScore -= 8;
  
  // Bound score
  shortScore = Math.max(5, Math.min(99, shortScore));
  
  // Update UI Scores
  const scoreDisplay = document.getElementById('rebound-score');
  scoreDisplay.innerText = `${longScore}%`;
  
  const ratingDisplay = document.getElementById('rebound-rating');
  let ratingText = '';
  let ratingColor = '';
  
  if (longScore >= 80) {
    ratingText = '极高反弹盈亏比 (强力买入区)';
    ratingColor = 'var(--color-success)';
  } else if (longScore >= 60) {
    ratingText = '良好反弹盈亏比 (分批吸筹区)';
    ratingColor = 'var(--color-primary)';
  } else if (longScore >= 40) {
    ratingText = '中等反弹风险 (观望行情)';
    ratingColor = 'var(--color-warning)';
  } else {
    ratingText = '极高踩踏风险 (避免建仓)';
    ratingColor = 'var(--color-danger)';
  }
  
  ratingDisplay.innerText = ratingText;
  ratingDisplay.style.color = ratingColor;

  const shortScoreDisplay = document.getElementById('short-score');
  shortScoreDisplay.innerText = `${shortScore}%`;

  const shortRatingDisplay = document.getElementById('short-rating');
  let shortRatingText = '';
  let shortRatingColor = '';
  
  if (shortScore >= 80) {
    shortRatingText = '极高做空盈亏比 (强力抛售区)';
    shortRatingColor = 'var(--color-danger)';
  } else if (shortScore >= 60) {
    shortRatingText = '良好做空盈亏比 (分批摸顶区)';
    shortRatingColor = 'rgba(155, 81, 224, 1)'; // Neon Purple
  } else if (shortScore >= 40) {
    shortRatingText = '中等做空风险 (观望行情)';
    shortRatingColor = 'var(--color-warning)';
  } else {
    shortRatingText = '极低做空盈亏比 (避免做空)';
    shortRatingColor = 'var(--color-success)';
  }
  
  shortRatingDisplay.innerText = shortRatingText;
  shortRatingDisplay.style.color = shortRatingColor;
  
  // 1c. Determine and highlight the recommended playbook strategies in the table
  const recCellA = document.getElementById('setup-a-rec');
  const recCellB = document.getElementById('setup-b-rec');
  const recCellC = document.getElementById('setup-c-rec');
  const recCellD = document.getElementById('setup-d-rec');

  const rowA = document.getElementById('row-setup-a');
  const rowB = document.getElementById('row-setup-b');
  const rowC = document.getElementById('row-setup-c');
  const rowD = document.getElementById('row-setup-d');

  // Reset all playbook rows & badges
  if (recCellA) recCellA.innerHTML = '<span class="table-normal-badge">常规方案</span>';
  if (recCellB) recCellB.innerHTML = '<span class="table-normal-badge">常规方案</span>';
  if (recCellC) recCellC.innerHTML = '<span class="table-normal-badge">常规方案</span>';
  if (recCellD) recCellD.innerHTML = '<span class="table-normal-badge">常规方案</span>';

  if (rowA) rowA.className = '';
  if (rowB) rowB.className = '';
  if (rowC) rowC.className = '';
  if (rowD) rowD.className = '';

  // Determine Long recommendation
  if (longScore >= 60 || (longScore >= shortScore && longScore >= 50)) {
    if (emaPos === 'below') {
      if (recCellA) recCellA.innerHTML = '<span class="table-rec-badge"><i class="fa-solid fa-circle-check"></i> AI 优先推荐</span>';
      if (rowA) rowA.className = 'row-recommended-long';
    } else {
      if (recCellB) recCellB.innerHTML = '<span class="table-rec-badge"><i class="fa-solid fa-circle-check"></i> AI 优先推荐</span>';
      if (rowB) rowB.className = 'row-recommended-long';
    }
  }

  // Determine Short recommendation
  if (shortScore >= 60 || (shortScore > longScore && shortScore >= 50)) {
    if (emaPos === 'above') {
      if (recCellC) recCellC.innerHTML = '<span class="table-short-badge"><i class="fa-solid fa-circle-check"></i> AI 优先推荐</span>';
      if (rowC) rowC.className = 'row-recommended-short';
    } else {
      if (recCellD) recCellD.innerHTML = '<span class="table-short-badge"><i class="fa-solid fa-circle-check"></i> AI 优先推荐</span>';
      if (rowD) rowD.className = 'row-recommended-short';
    }
  }
  
  // Generate detailed narrative explanation
  const explanation = document.getElementById('rebound-explanation');
  let explanationText = "";
  
  explanationText += `【市场状态诊断】当前市场情绪为【${fngClassification === 'Extreme Fear' ? '极度恐慌' : '恐慌' || fngClassification}】(指数: ${fngValue})，大周期处于200日均线【${emaPos === 'above' ? '上方 (多头占优)' : '下方 (空头占优)'}】。`;
  
  explanationText += `\n【多头策略】多头评分 ${longScore}%。`;
  if (longScore >= 60) {
    explanationText += `鉴于情绪处于恐慌且做空资金拥挤，超跌反弹的胜率较高。建议关注多头清算峰值附近的支撑力度，在 Level 1 (${level1Price}) 到 Level 2 (${level2Price}) 挂单买入，止损设于极限支撑下方。`;
  } else {
    explanationText += `目前多头拥挤或反弹信号不明显，追多风险较大。建议保持耐心，仅在极低支撑位 (${level2Price}) 尝试轻仓埋伏。`;
  }
  
  explanationText += `\n【空头策略】空头评分 ${shortScore}%。`;
  if (shortScore >= 60) {
    explanationText += `目前大盘处于趋势偏弱或做多拥挤区，上方阻力带清算强度密集。建议在空头清算峰值 ${shortPeak1} 到 ${shortPeak2} 之间分批挂空单防守，利用多头反弹衰竭进行高空布局。`;
  } else {
    explanationText += `当前市场空头势能偏弱或处于恐慌超跌区间，做空极易被爆空踩踏。不建议在此位置盲目追空或摸顶。`;
  }
  
  let techNotes = [];
  if (dxy === 'falling') techNotes.push("美元指数回落利好风险资产");
  else techNotes.push("美元指数走强压制加密市场");
  
  if (etf === 'inflow') techNotes.push("美国现货 ETF 资金持续流入，提供现货支撑");
  else techNotes.push("现货 ETF 资金流出，买盘动能偏弱");
  
  if (pattern === 'yes') techNotes.push("K线已现反转筑底信号");
  if (walls === 'buy-wall') techNotes.push("买单墙拦截厚实");
  
  if (techNotes.length > 0) {
    explanationText += `\n【宏观与技术面】${techNotes.join('，')}。`;
  }
  
  explanation.innerText = explanationText;
  
  // Sync backtest orders with newly calculated levels
  syncBacktestOrders();
}

// Copy Price to Clipboard
function copyPrice(elementId) {
  const priceText = document.getElementById(elementId).innerText;
  // Strip currency signs and commas
  const cleanedPrice = priceText.replace(/(USD|usd|\$|,|\s)/g, '');
  
  navigator.clipboard.writeText(cleanedPrice).then(() => {
    // Show visual confirmation on the button
    const card = document.getElementById(elementId).parentElement;
    const btn = card.querySelector('.btn-copy');
    const originalText = btn.innerHTML;
    
    btn.innerHTML = '<i class="fa-solid fa-check"></i> 已复制!';
    btn.style.background = 'var(--color-success)';
    btn.style.color = 'black';
    
    setTimeout(() => {
      btn.innerHTML = originalText;
      btn.style.background = 'rgba(255, 255, 255, 0.05)';
      btn.style.color = 'var(--color-text-main)';
    }, 1500);
  }).catch(err => {
    console.error('Failed to copy text: ', err);
  });
}

// Wrapper to fetch all live metrics in one go
function fetchAllLiveMetrics(symbol) {
  fetchLiveFundingRate(symbol);
  fetch200EMA(symbol);
  fetchDXYProxy();
  fetchETFFlowProxy();
  fetchRSIPattern(symbol);
  fetchOrderBookWalls(symbol);
  fetchCNHRate();
}

// Fetch Live Funding Rate from Binance Futures API (with Gate.io fallback)
async function fetchLiveFundingRate(symbol) {
  let rate = null;
  let success = false;
  
  // Try 1: OKX Futures Funding Rate API (CORS-enabled & accessible)
  try {
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/public/funding-rate?instId=${symbol}-USDT-SWAP`, { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      if (data && data.data && data.data.length > 0) {
        rate = parseFloat(data.data[0].fundingRate);
        success = true;
      }
    }
  } catch (e) {
    console.warn("OKX Futures Funding Rate API failed, trying Binance fapi...", e);
  }

  // Try 2: Binance Futures API (as fallback, might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}USDT`, { timeout: 1500 });
      if (response.ok) {
        const data = await response.json();
        rate = parseFloat(data.lastFundingRate);
        success = true;
      }
    } catch (e) {
      console.warn("Binance fapi failed.");
    }
  }
  
  // Render
  if (success && rate !== null) {
    const selectFunding = document.getElementById('select-funding');
    if (selectFunding) {
      if (rate < 0) {
        selectFunding.value = 'negative';
      } else if (rate >= 0.0003) {
        selectFunding.value = 'high';
      } else {
        selectFunding.value = 'normal';
      }
      // Update label with actual rate
      const label = selectFunding.parentElement.previousElementSibling;
      if (label) {
        label.innerHTML = `资金费率 (实时: ${(rate * 100).toFixed(4)}%)`;
      }
      // Trigger recalculation
      runCalculator();
    }
  }
}

// Fetch 200 EMA from Binance Spot API (with Binance Vision & Gate.io fallbacks)
async function fetch200EMA(symbol) {
  let data = null;
  let success = false;
  
  // Try 1: OKX Spot Candlesticks (CORS-enabled & accessible)
  try {
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=1D&limit=250`, { timeout: 1500 });
    if (response.ok) {
      const rawData = await response.json();
      if (rawData && rawData.data) {
        // OKX returns newest first, so we reverse it to chronological order
        const mapped = rawData.data.map(item => [0, 0, 0, 0, parseFloat(item[4])]); // item[4] is close price
        mapped.reverse();
        data = mapped;
        success = true;
      }
    }
  } catch (e) {
    console.warn("OKX daily kline failed, trying vision klines...", e);
  }

  // Try 2: Binance Vision Spot API (GFW-free developer sandbox)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=250`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Vision daily kline failed, trying primary Binance Spot...", e);
    }
  }

  // Try 3: Binance Spot API (might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=1d&limit=250`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Spot daily kline failed.");
    }
  }
  
  if (success && data) {
    const prices = data.map(item => parseFloat(item[4]));
    if (prices.length >= 200) {
      const ema200 = calculateEMA(prices, 200);
      const selectEma = document.getElementById('select-ema');
      if (selectEma) {
        if (currentPrice > ema200) {
          selectEma.value = 'above';
        } else {
          selectEma.value = 'below';
        }
        // Update label with EMA value
        const label = selectEma.parentElement.previousElementSibling;
        if (label) {
          label.innerHTML = `价格 vs 200日EMA (均线: ${Math.round(ema200)})`;
        }
        // Trigger recalculation
        runCalculator();
      }
    }
  }
}

function calculateEMA(prices, period = 200) {
  let k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

// Fetch EURUSDT 24h change as DXY proxy (with Binance Vision & Gate.io fallbacks)
async function fetchDXYProxy() {
  let change = null;
  let success = false;
  
  // Try 1: OKX EUR-USDT Spot Ticker (CORS-enabled & accessible)
  try {
    const response = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=EUR-USDT', { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      if (data && data.data && data.data.length > 0) {
        const last = parseFloat(data.data[0].last);
        const open24h = parseFloat(data.data[0].open24h);
        if (open24h > 0) {
          change = ((last - open24h) / open24h) * 100;
          success = true;
        }
      }
    }
  } catch (e) {
    console.warn("OKX EUR-USDT ticker failed, trying vision...", e);
  }

  // Try 2: Binance Vision API (CORS-enabled developer sandbox)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://data-api.binance.vision/api/v3/ticker/24hr?symbol=EURUSDT', { timeout: 1500 });
      if (response.ok) {
        const data = await response.json();
        change = parseFloat(data.priceChangePercent);
        success = true;
      }
    } catch (e) {
      console.warn("Binance Vision CXY ticker failed, trying primary Binance Spot...", e);
    }
  }

  // Try 3: Binance Spot API (might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr?symbol=EURUSDT', { timeout: 1500 });
      if (response.ok) {
        const data = await response.json();
        change = parseFloat(data.priceChangePercent);
        success = true;
      }
    } catch (e) {
      console.warn("Binance Spot CXY ticker failed.");
    }
  }
  
  if (success && change !== null) {
    const selectDxy = document.getElementById('select-dxy');
    if (selectDxy) {
      if (change > 0.05) {
        selectDxy.value = 'falling'; // EUR is rising -> USD/DXY is falling
      } else if (change < -0.05) {
        selectDxy.value = 'rising'; // EUR is falling -> USD/DXY is rising
      }
      const label = selectDxy.parentElement.previousElementSibling;
      if (label) {
        label.innerHTML = `美元指数 (DXY) (欧元变动: ${change > 0 ? '+' : ''}${change.toFixed(2)}%)`;
      }
      runCalculator();
    }
  }
}

// Fetch Coinbase vs Binance price to estimate ETF flows (with Gate.io fallback)
async function fetchETFFlowProxy() {
  let cbPrice = null;
  let success = false;
  
  // Try 1: Coinbase Spot API
  try {
    const response = await fetchWithTimeout('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 1500 });
    if (response.ok) {
      const data = await response.json();
      cbPrice = parseFloat(data.data.amount);
      success = true;
    }
  } catch (e) {
    console.warn("Coinbase spot API failed, trying Gate.io proxy...");
  }
  
  // Try 2: OKX Spot API as fallback (CORS-enabled & accessible)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT', { timeout: 1500 });
      if (response.ok) {
        const data = await response.json();
        if (data && data.data && data.data.length > 0) {
          cbPrice = parseFloat(data.data[0].last);
          success = true;
        }
      }
    } catch (e) {
      console.warn("OKX spot API failed.", e);
    }
  }
  
  if (success && cbPrice && currentPrice > 0) {
    const selectEtf = document.getElementById('select-etf');
    if (selectEtf) {
      const premium = ((cbPrice - currentPrice) / currentPrice) * 100;
      if (premium > 0.05) {
        selectEtf.value = 'inflow';
      } else if (premium < -0.05) {
        selectEtf.value = 'outflow';
      }
      const label = selectEtf.parentElement.previousElementSibling;
      if (label) {
        label.innerHTML = `美国现货 ETF 资金 (溢价: ${premium > 0 ? '+' : ''}${premium.toFixed(3)}%)`;
      }
      runCalculator();
    }
  }
}

// Fetch 4h Klines to compute RSI as technical pattern indicator (with fallbacks)
async function fetchRSIPattern(symbol) {
  let data = null;
  let success = false;
  
  // Try 1: OKX 4H Spot Candlesticks (CORS-enabled & accessible)
  try {
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/market/candles?instId=${symbol}-USDT&bar=4H&limit=100`, { timeout: 1500 });
    if (response.ok) {
      const rawData = await response.json();
      if (rawData && rawData.data) {
        const mapped = rawData.data.map(item => [0, 0, 0, 0, parseFloat(item[4])]); // item[4] is close price
        mapped.reverse();
        data = mapped;
        success = true;
      }
    }
  } catch (e) {
    console.warn("OKX 4h kline failed, trying vision...", e);
  }

  // Try 2: Binance Vision Spot API (CORS-enabled developer sandbox)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}USDT&interval=4h&limit=100`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Vision 4h kline failed, trying primary Binance Spot...", e);
    }
  }

  // Try 3: Binance Spot API (might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=4h&limit=100`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Spot 4h kline failed.");
    }
  }
  
  if (success && data) {
    const prices = data.map(item => parseFloat(item[4]));
    if (prices.length >= 15) {
      const rsi = calculateRSI(prices, 14);
      const selectPattern = document.getElementById('select-pattern');
      if (selectPattern) {
        if (rsi < 35) {
          selectPattern.value = 'yes';
        } else {
          selectPattern.value = 'no';
        }
        const label = selectPattern.parentElement.previousElementSibling;
        if (label) {
          label.innerHTML = `看涨 K 线 / RSI底背离 (4h RSI: ${Math.round(rsi)})`;
        }
        runCalculator();
      }
    }
  }
}

function calculateRSI(prices, period = 14) {
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    let diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  for (let i = period + 1; i < prices.length; i++) {
    let diff = prices[i] - prices[i - 1];
    if (diff > 0) {
      avgGain = (avgGain * 13 + diff) / 14;
      avgLoss = (avgLoss * 13) / 14;
    } else {
      avgGain = (avgGain * 13) / 14;
      avgLoss = (avgLoss * 13 - diff) / 14;
    }
  }
  
  if (avgLoss === 0) return 100;
  let rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Fetch Order Book Depth to evaluate walls (with fallbacks)
async function fetchOrderBookWalls(symbol) {
  let data = null;
  let success = false;
  
  // Try 1: OKX Order Book Depth (CORS-enabled & accessible)
  try {
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/market/books?instId=${symbol}-USDT&sz=100`, { timeout: 1500 });
    if (response.ok) {
      const rawData = await response.json();
      if (rawData && rawData.data && rawData.data.length > 0) {
        data = rawData.data[0];
        success = true;
      }
    }
  } catch (e) {
    console.warn("OKX order book depth failed, trying vision...", e);
  }

  // Try 2: Binance Vision depth (CORS-enabled developer sandbox)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/depth?symbol=${symbol}USDT&limit=100`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Vision depth failed, trying primary Binance Spot...", e);
    }
  }

  // Try 3: Binance Spot API (might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout(`https://api.binance.com/api/v3/depth?symbol=${symbol}USDT&limit=100`, { timeout: 1500 });
      if (response.ok) {
        data = await response.json();
        success = true;
      }
    } catch (e) {
      console.warn("Binance Spot depth failed.");
    }
  }
  
  if (success && data) {
    const bids = data.bids;
    const asks = data.asks;
    
    let bidsVolume = 0;
    let asksVolume = 0;
    
    const priceLimitLow = currentPrice * 0.98;
    const priceLimitHigh = currentPrice * 1.02;
    
    for (let bid of bids) {
      const price = parseFloat(bid[0]);
      const qty = parseFloat(bid[1]);
      if (price >= priceLimitLow) {
        bidsVolume += qty * price;
      }
    }
    
    for (let ask of asks) {
      const price = parseFloat(ask[0]);
      const qty = parseFloat(ask[1]);
      if (price <= priceLimitHigh) {
        asksVolume += qty * price;
      }
    }
    
    const selectWalls = document.getElementById('select-walls');
    if (selectWalls) {
      if (bidsVolume > asksVolume * 1.2) {
        selectWalls.value = 'buy-wall';
      } else {
        selectWalls.value = 'neutral';
      }
      const label = selectWalls.parentElement.previousElementSibling;
      if (label) {
        label.innerHTML = `订单簿挂单壁垒 (买/卖: ${(bidsVolume / asksVolume).toFixed(2)})`;
      }
      runCalculator();
    }
  }
}

// Fetch Live CNH exchange rate and 24h change from Binance API (with Vision & open.er-api fallbacks)
async function fetchCNHRate() {
  let price = null;
  let change = null;
  let success = false;
  let source = '';

  // Try 1: open.er-api.com (GFW-free & Region-free, CORS-enabled)
  try {
    const response = await fetchWithTimeout('https://open.er-api.com/v6/latest/USD', { timeout: 2000 });
    if (response.ok) {
      const data = await response.json();
      if (data && data.rates) {
        price = parseFloat(data.rates.CNH || data.rates.CNY);
        officialUSDCNH = price; // Store official USD/CNH rate
        change = 0; // Daily rate API doesn't provide 24h change
        success = true;
        source = 'OpenER';
      }
    }
  } catch (e) {
    console.warn("Open ER API CNH rate fetch failed, trying alternative...", e.message);
  }

  // Try 2: exchangerate.fun (Alternative GFW-free fallback)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://api.exchangerate.fun/latest?base=USD', { timeout: 2000 });
      if (response.ok) {
        const data = await response.json();
        if (data && data.rates) {
          price = parseFloat(data.rates.CNH || data.rates.CNY);
          officialUSDCNH = price; // Store official USD/CNH rate
          change = 0;
          success = true;
          source = 'ExchangerateFun';
        }
      }
    } catch (e) {
      console.warn("ExchangerateFun CNH rate fetch failed, trying Binance...", e.message);
    }
  }

  // Try 3: Binance Spot API (might block with CORS/451)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://api.binance.com/api/v3/ticker/24hr?symbol=USDTCNH', { timeout: 2000 });
      if (response.ok) {
        const data = await response.json();
        price = parseFloat(data.lastPrice);
        change = parseFloat(data.priceChangePercent);
        usdtCnhPrice = price; // Store real-time USDT/CNH price
        success = true;
        source = 'Binance';
      }
    } catch (e) {
      console.warn("Binance CNH rate fetch failed:", e.message);
    }
  }

  // Try 4: Binance API3 (Backup Binance endpoint)
  if (!success) {
    try {
      const response = await fetchWithTimeout('https://api3.binance.com/api/v3/ticker/24hr?symbol=USDTCNH', { timeout: 2000 });
      if (response.ok) {
        const data = await response.json();
        price = parseFloat(data.lastPrice);
        change = parseFloat(data.priceChangePercent);
        usdtCnhPrice = price; // Store real-time USDT/CNH price
        success = true;
        source = 'Binance';
      }
    } catch (e) {
      console.warn("Binance API3 CNH rate fetch failed:", e.message);
    }
  }

  // Render
  const rateDisplay = document.getElementById('cnh-rate-display');
  const rateTrend = document.getElementById('cnh-rate-trend');

  if (success && price !== null) {
    cnhRate = price; // Update the global conversion rate
    if (rateDisplay) {
      rateDisplay.innerText = price.toFixed(4);
    }
    if (rateTrend) {
      if (source === 'Binance') {
        rateTrend.innerText = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`;
        if (change > 0) {
          rateTrend.style.background = 'rgba(0, 230, 118, 0.15)';
          rateTrend.style.color = 'var(--color-success)';
          rateTrend.style.borderColor = 'rgba(0, 230, 118, 0.3)';
        } else if (change < 0) {
          rateTrend.style.background = 'rgba(255, 23, 68, 0.15)';
          rateTrend.style.color = 'var(--color-danger)';
          rateTrend.style.borderColor = 'rgba(255, 23, 68, 0.3)';
        } else {
          rateTrend.style.background = 'rgba(255, 255, 255, 0.04)';
          rateTrend.style.color = 'var(--color-text-muted)';
          rateTrend.style.borderColor = 'rgba(255, 255, 255, 0.08)';
        }
      } else {
        // Daily reference rate from forex APIs
        rateTrend.innerText = "日更基准";
        rateTrend.style.background = 'rgba(2, 136, 209, 0.15)'; // Slate Blue
        rateTrend.style.color = 'rgba(2, 136, 209, 1)';
        rateTrend.style.borderColor = 'rgba(2, 136, 209, 0.3)';
      }
    }
  } else {
    // If all fail, display fallback offline value
    cnhRate = 7.2500;
    if (rateDisplay) {
      rateDisplay.innerText = "7.2500";
    }
    if (rateTrend) {
      rateTrend.innerText = "离线数据";
      rateTrend.style.background = 'rgba(255, 152, 0, 0.15)'; // Orange
      rateTrend.style.color = 'var(--color-warning)';
      rateTrend.style.borderColor = 'rgba(255, 152, 0, 0.3)';
    }
  }

  // Trigger recalculation to sync the CNY conversions
  runCalculator();
}

// ==========================================
// MOCK TRADING PORTFOLIO SYSTEM IMPLEMENTATION
// ==========================================

function loadPortfolio() {
  const stored = localStorage.getItem('crypto_advisor_portfolio');
  if (stored) {
    try {
      portfolio = JSON.parse(stored);
      if (typeof portfolio.balance === 'number' || !portfolio.BTC || !portfolio.ETH) {
        resetPortfolioState();
      } else {
        ['BTC', 'ETH'].forEach(token => {
          if (!portfolio[token]) {
            portfolio[token] = { balance: 2000.0, pendingOrders: [], activePositions: [], history: [] };
          }
          if (!portfolio[token].pendingOrders) portfolio[token].pendingOrders = [];
          if (!portfolio[token].activePositions) portfolio[token].activePositions = [];
          if (!portfolio[token].history) portfolio[token].history = [];
          if (typeof portfolio[token].balance !== 'number' || portfolio[token].balance === 100000.0) {
            portfolio[token].balance = 2000.0;
            portfolio[token].pendingOrders = [];
            portfolio[token].activePositions = [];
            portfolio[token].history = [];
          }
        });
      }
    } catch (e) {
      console.error("Failed to parse portfolio from localStorage, resetting...", e);
      resetPortfolioState();
    }
  } else {
    resetPortfolioState();
  }
  renderPortfolioUI();
}

function loadBacktest() {
  const stored = localStorage.getItem('crypto_advisor_backtest');
  if (stored) {
    try {
      backtest = JSON.parse(stored);
      let needsReset = !backtest.portfolios;
      if (!needsReset) {
        ['A', 'B', 'C', 'D'].forEach(letter => {
          const port = backtest.portfolios[letter];
          if (!port || (port.balance !== undefined && (port.BTC === undefined || port.ETH === undefined))) {
            needsReset = true;
          }
        });
      }
      
      if (needsReset) {
        resetBacktestState();
      } else {
        ['A', 'B', 'C', 'D'].forEach(letter => {
          ['BTC', 'ETH'].forEach(token => {
            if (!backtest.portfolios[letter][token]) {
              backtest.portfolios[letter][token] = { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] };
            }
            if (!backtest.portfolios[letter][token].history) backtest.portfolios[letter][token].history = [];
            if (typeof backtest.portfolios[letter][token].balance !== 'number' || backtest.portfolios[letter][token].balance === 100000.0) {
              backtest.portfolios[letter][token].balance = 2000.0;
              backtest.portfolios[letter][token].pendingOrder = null;
              backtest.portfolios[letter][token].activePosition = null;
              backtest.portfolios[letter][token].history = [];
            }
          });
        });
      }
    } catch (e) {
      console.error("Failed to parse backtest from localStorage, resetting...", e);
      resetBacktestState();
    }
  } else {
    resetBacktestState();
  }
  renderBacktestComparisonTable();
}

function savePortfolio() {
  localStorage.setItem('crypto_advisor_portfolio', JSON.stringify(portfolio));
  syncStateToSupabase();
}

function saveBacktest() {
  localStorage.setItem('crypto_advisor_backtest', JSON.stringify(backtest));
  syncStateToSupabase();
}

function resetPortfolioState() {
  resetCounter++;
  portfolio = {
    lastSyncTime: Date.now(),
    BTC: { balance: 2000.0, pendingOrders: [], activePositions: [], history: [] },
    ETH: { balance: 2000.0, pendingOrders: [], activePositions: [], history: [] }
  };
  savePortfolio();
}

function resetBacktestState() {
  resetCounter++;
  backtest = {
    lastSyncTime: Date.now(),
    portfolios: {
      A: {
        BTC: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] },
        ETH: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] }
      },
      B: {
        BTC: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] },
        ETH: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] }
      },
      C: {
        BTC: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] },
        ETH: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] }
      },
      D: {
        BTC: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] },
        ETH: { balance: 2000.0, pendingOrder: null, activePosition: null, history: [] }
      }
    }
  };
  saveBacktest();
}

function resetMockPortfolio() {
  if (confirm("您确定要重置所有模拟数据吗？这会同时清空【用户手动交易】以及【所有AI回测策略】的历史记录与余额！")) {
    resetPortfolioState();
    resetBacktestState();
    activeAccountId = 'manual';
    
    const rows = document.querySelectorAll('.backtest-comparison-table tbody tr');
    rows.forEach(r => r.classList.remove('active'));
    document.getElementById('backtest-row-manual').classList.add('active');
    
    const btns = document.querySelectorAll('.btn-select-account');
    btns.forEach(b => {
      b.classList.remove('active');
      b.innerText = '查看详情';
    });
    document.getElementById('btn-acc-manual').classList.add('active');
    document.getElementById('btn-acc-manual').innerText = '当前选中';
    
    document.getElementById('active-account-display-name').innerText = '用户手动交易 (Manual)';
    
    loadPortfolio();
    loadBacktest();
    
    // Reset inputs to default values based on current live prices immediately
    resetDefaults(activeToken);
    
    const banner = document.getElementById('sync-notification-banner');
    if (banner) banner.style.display = 'none';
  }
}

// Modal Form Controllers
function openOrderModal(setupLetter) {
  selectedSetupLetter = setupLetter;
  
  let name = '';
  let entryStr = '';
  let slStr = '';
  let tpStr = '';
  
  if (setupLetter === 'A') {
    name = '方案 A: 左侧低吸 (防守多)';
    entryStr = document.getElementById('setup-a-entry').innerText;
    slStr = document.getElementById('setup-a-sl').innerText;
    tpStr = document.getElementById('setup-a-tp').innerText;
  } else if (setupLetter === 'B') {
    name = '方案 B: 右侧突破 (顺势多)';
    entryStr = document.getElementById('setup-b-entry').innerText;
    slStr = document.getElementById('setup-b-sl').innerText;
    tpStr = document.getElementById('setup-b-tp').innerText;
  } else if (setupLetter === 'C') {
    name = '方案 C: 左侧高空 (防守空)';
    entryStr = document.getElementById('setup-c-entry').innerText.split('-')[0];
    slStr = document.getElementById('setup-c-sl').innerText;
    tpStr = document.getElementById('setup-c-tp').innerText;
  } else if (setupLetter === 'D') {
    name = '方案 D: 右侧破位 (顺势空)';
    entryStr = document.getElementById('setup-d-entry').innerText;
    slStr = document.getElementById('setup-d-sl').innerText;
    tpStr = document.getElementById('setup-d-tp').innerText;
  }
  
  document.getElementById('modal-setup-name').innerText = name;
  document.getElementById('modal-setup-symbol').innerText = activeToken;
  document.getElementById('modal-entry-val').innerText = entryStr;
  document.getElementById('modal-sl-val').innerText = slStr;
  document.getElementById('modal-tp-val').innerText = tpStr;
  
  document.getElementById('modal-available-balance').innerText = `$${portfolio[activeToken].balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.getElementById('modal-input-amount').value = 166.67;
  
  document.getElementById('order-modal').style.display = 'flex';
}

function closeOrderModal() {
  document.getElementById('order-modal').style.display = 'none';
  selectedSetupLetter = null;
}

function setModalAmount(amount) {
  document.getElementById('modal-input-amount').value = amount;
}

function setModalPercent(percent) {
  if (!portfolio || !portfolio[activeToken]) return;
  const amount = Math.floor(portfolio[activeToken].balance * percent);
  document.getElementById('modal-input-amount').value = Math.max(100, amount);
}

function confirmMockOrder() {
  if (!selectedSetupLetter || !portfolio || !portfolio[activeToken]) return;
  
  const amount = parseFloat(document.getElementById('modal-input-amount').value);
  const leverage = parseInt(document.getElementById('modal-select-leverage').value);
  
  if (isNaN(amount) || amount <= 0) {
    alert("请输入有效的模拟投入本金金额！");
    return;
  }
  
  if (amount > portfolio[activeToken].balance) {
    alert("账户余额不足，无法执行挂单！");
    return;
  }
  
  let entryPrice = 0;
  let sl = 0;
  let tp = 0;
  let setupName = '';
  let direction = 'long';
  let type = 'limit';
  
  const cleanPrice = (str) => parseFloat(str.replace(/(USD|usd|\$|,|\s)/g, ''));
  
  if (selectedSetupLetter === 'A') {
    setupName = '方案 A: 左侧低吸 (防守多)';
    const range = document.getElementById('setup-a-entry').innerText.split('-');
    // Left-side range limits: buy upper limit of the target zone
    entryPrice = cleanPrice(range[1] || range[0]);
    sl = cleanPrice(document.getElementById('setup-a-sl').innerText);
    tp = cleanPrice(document.getElementById('setup-a-tp').innerText);
    direction = 'long';
    type = 'limit';
  } else if (selectedSetupLetter === 'B') {
    setupName = '方案 B: 右侧突破 (顺势多)';
    entryPrice = cleanPrice(document.getElementById('setup-b-entry').innerText);
    sl = cleanPrice(document.getElementById('setup-b-sl').innerText);
    tp = cleanPrice(document.getElementById('setup-b-tp').innerText);
    direction = 'long';
    type = 'stop_limit';
  } else if (selectedSetupLetter === 'C') {
    setupName = '方案 C: 左侧高空 (防守空)';
    const range = document.getElementById('setup-c-entry').innerText.split('-');
    // Left-side short range: entry at lower bound of the target zone
    entryPrice = cleanPrice(range[0]);
    sl = cleanPrice(document.getElementById('setup-c-sl').innerText);
    tp = cleanPrice(document.getElementById('setup-c-tp').innerText);
    direction = 'short';
    type = 'limit';
  } else if (selectedSetupLetter === 'D') {
    setupName = '方案 D: 右侧破位 (顺势空)';
    entryPrice = cleanPrice(document.getElementById('setup-d-entry').innerText);
    sl = cleanPrice(document.getElementById('setup-d-sl').innerText);
    tp = cleanPrice(document.getElementById('setup-d-tp').innerText);
    direction = 'short';
    type = 'stop_limit';
  }
  
  if (isNaN(entryPrice) || entryPrice <= 0 || isNaN(sl) || isNaN(tp)) {
    alert("挂单价格未能解析，请确认输入了正确的爆仓峰值！");
    return;
  }
  
  portfolio[activeToken].balance -= amount;
  
  const newOrder = {
    id: 'order-' + Date.now(),
    symbol: activeToken,
    setupName: setupName,
    direction: direction,
    type: type,
    entryPrice: entryPrice,
    sl: sl,
    tp: tp,
    margin: leverage,
    amount: amount,
    createTime: Date.now()
  };
  
  portfolio[activeToken].pendingOrders.push(newOrder);
  savePortfolio();
  renderPortfolioUI();
  closeOrderModal();
}

function cancelPendingOrder(id) {
  if (activeAccountId === 'manual') {
    if (!portfolio || !portfolio[activeToken]) return;
    const idx = portfolio[activeToken].pendingOrders.findIndex(o => o.id === id);
    if (idx !== -1) {
      const order = portfolio[activeToken].pendingOrders[idx];
      portfolio[activeToken].balance += order.amount;
      portfolio[activeToken].pendingOrders.splice(idx, 1);
      savePortfolio();
      renderPortfolioUI();
    }
  } else {
    // Strategy portfolio
    const port = backtest.portfolios[activeAccountId][activeToken];
    if (port && port.pendingOrder) {
      const order = port.pendingOrder;
      port.balance += order.amount;
      port.pendingOrder = null;
      saveBacktest();
      renderBacktestComparisonTable();
      renderPortfolioUI();
      alert(`[方案 ${activeAccountId}] 手动撤单成功！`);
    }
  }
}

function closeActivePosition(id) {
  const price = activeToken === 'BTC' ? btcPrice : ethPrice;
  if (!price || price <= 0) {
    alert("无法获取当前最新价格，暂时无法市价平仓！");
    return;
  }
  
  if (activeAccountId === 'manual') {
    if (!portfolio || !portfolio[activeToken]) return;
    const idx = portfolio[activeToken].activePositions.findIndex(p => p.id === id);
    if (idx !== -1) {
      const pos = portfolio[activeToken].activePositions[idx];
      const pnlResult = calculatePnL(pos, price);
      portfolio[activeToken].balance += (pos.amount + pnlResult.pnl);
      
      const histItem = {
        id: 'hist-' + Date.now(),
        symbol: pos.symbol,
        setupName: pos.setupName,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: price,
        amount: pos.amount,
        margin: pos.margin,
        pnl: pnlResult.pnl,
        pnlPercent: pnlResult.pnlPercent,
        closeTime: Date.now(),
        closeReason: 'manual'
      };
      
      portfolio[activeToken].history.push(histItem);
      portfolio[activeToken].activePositions.splice(idx, 1);
      savePortfolio();
      renderPortfolioUI();
      alert("手动平仓成功！");
    }
  } else {
    // Strategy portfolio
    const port = backtest.portfolios[activeAccountId][activeToken];
    if (port && port.activePosition) {
      const pos = port.activePosition;
      const pnlResult = calculatePnL(pos, price);
      port.balance += (pos.amount + pnlResult.pnl);
      
      const histItem = {
        id: 'hist-' + Date.now(),
        symbol: pos.symbol,
        setupName: pos.setupName,
        direction: pos.direction,
        entryPrice: pos.entryPrice,
        exitPrice: price,
        amount: pos.amount,
        margin: pos.margin,
        pnl: pnlResult.pnl,
        pnlPercent: pnlResult.pnlPercent,
        closeTime: Date.now(),
        closeReason: 'manual'
      };
      
      port.history.push(histItem);
      port.activePosition = null;
      saveBacktest();
      renderBacktestComparisonTable();
      renderPortfolioUI();
      alert(`[${pos.setupName}] 手动市价平仓成功！`);
    }
  }
}

function calculatePnL(pos, exitPrice) {
  const directionMultiplier = pos.direction === 'long' ? 1 : -1;
  const priceChangePercent = ((exitPrice - pos.entryPrice) / pos.entryPrice) * directionMultiplier;
  
  let pnlPercent = priceChangePercent * pos.margin;
  if (pnlPercent <= -1.0) {
    pnlPercent = -1.0; // Liquidation (100% loss)
  }
  
  const pnl = pos.amount * pnlPercent;
  
  return {
    pnl: pnl,
    pnlPercent: pnlPercent * 100
  };
}

// Sync AI calculated prices with backtest pending orders
function syncBacktestOrders() {
  if (!backtest || !backtest.portfolios) return;
  if (!isOfflineSyncCompleted) return; // Wait until offline history replay is complete
  
  // Make sure we have a valid price for the active token
  const price = activeToken === 'BTC' ? btcPrice : ethPrice;
  if (!price || price <= 0) return;
  
  const cleanPrice = (str) => parseFloat(str.replace(/(USD|usd|\$|,|\s)/g, ''));
  let levels = {};
  
  try {
    if (activeToken === 'BTC' || activeToken === 'ETH') {
      levels.A = {
        entry: cleanPrice(document.getElementById('setup-a-entry').innerText.split('-')[1] || document.getElementById('setup-a-entry').innerText),
        sl: cleanPrice(document.getElementById('setup-a-sl').innerText),
        tp: cleanPrice(document.getElementById('setup-a-tp').innerText),
        direction: 'long',
        type: 'limit'
      };
      
      levels.B = {
        entry: cleanPrice(document.getElementById('setup-b-entry').innerText),
        sl: cleanPrice(document.getElementById('setup-b-sl').innerText),
        tp: cleanPrice(document.getElementById('setup-b-tp').innerText),
        direction: 'long',
        type: 'stop_limit'
      };
      
      levels.C = {
        entry: cleanPrice(document.getElementById('setup-c-entry').innerText.split('-')[0]),
        sl: cleanPrice(document.getElementById('setup-c-sl').innerText),
        tp: cleanPrice(document.getElementById('setup-c-tp').innerText),
        direction: 'short',
        type: 'limit'
      };
      
      levels.D = {
        entry: cleanPrice(document.getElementById('setup-d-entry').innerText),
        sl: cleanPrice(document.getElementById('setup-d-sl').innerText),
        tp: cleanPrice(document.getElementById('setup-d-tp').innerText),
        direction: 'short',
        type: 'stop_limit'
      };
    }
  } catch (e) {
    return;
  }
  
  let isCalculated = true;
  ['A', 'B', 'C', 'D'].forEach(letter => {
    const lvl = levels[letter];
    if (!lvl || isNaN(lvl.entry) || lvl.entry <= 0 || isNaN(lvl.sl) || isNaN(lvl.tp)) {
      isCalculated = false;
    }
  });
  
  if (!isCalculated) return;
  
  let stateChanged = false;
  
  const nominalSize = 500.0;
  const leverage = 3;
  const marginRequired = nominalSize / leverage;
  
  ['A', 'B', 'C', 'D'].forEach(letter => {
    const port = backtest.portfolios[letter][activeToken];
    const lvl = levels[letter];
    
    if (port.activePosition !== null) return;
    
    if (port.pendingOrder === null) {
      if (port.balance >= marginRequired) {
        port.balance -= marginRequired;
        port.pendingOrder = {
          symbol: activeToken,
          setupName: letter === 'A' ? '方案 A: 左侧低吸 (防守多)' : (letter === 'B' ? '方案 B: 右侧突破 (顺势多)' : (letter === 'C' ? '方案 C: 左侧高空 (防守空)' : '方案 D: 右侧破位 (顺势空)')),
          direction: lvl.direction,
          type: lvl.type,
          entryPrice: lvl.entry,
          sl: lvl.sl,
          tp: lvl.tp,
          margin: leverage,
          amount: marginRequired,
          createTime: Date.now()
        };
        stateChanged = true;
      }
    } else {
      const order = port.pendingOrder;
      
      // For right-side breakout/breakdown (B and D), do not shift based on price fluctuations.
      // They should remain locked at their initial placement price.
      if ((letter === 'B' || letter === 'D') && order.symbol === activeToken) {
        return;
      }
      
      const isShifted = order.symbol !== activeToken || 
                        Math.abs(order.entryPrice - lvl.entry) > 0.01 ||
                        Math.abs(order.sl - lvl.sl) > 0.01 ||
                        Math.abs(order.tp - lvl.tp) > 0.01;
      
      if (isShifted) {
        port.pendingOrder = {
          symbol: activeToken,
          setupName: letter === 'A' ? '方案 A: 左侧低吸 (防守多)' : (letter === 'B' ? '方案 B: 右侧突破 (顺势多)' : (letter === 'C' ? '方案 C: 左侧高空 (防守空)' : '方案 D: 右侧破位 (顺势空)')),
          direction: lvl.direction,
          type: lvl.type,
          entryPrice: lvl.entry,
          sl: lvl.sl,
          tp: lvl.tp,
          margin: leverage,
          amount: order.amount, // Keep existing order amount to prevent balance leakage during shifts
          createTime: Date.now()
        };
        stateChanged = true;
      }
    }
  });
  
  if (stateChanged) {
    saveBacktest();
    renderBacktestComparisonTable();
    renderPortfolioUI();
  }
}

// Switch display account
function switchActiveAccount(accountId) {
  activeAccountId = accountId;
  localStorage.setItem('crypto_advisor_active_account', accountId);
  
  const rows = document.querySelectorAll('.backtest-comparison-table tbody tr');
  rows.forEach(r => r.classList.remove('active'));
  
  const rowElem = document.getElementById(`backtest-row-${accountId}`);
  if (rowElem) rowElem.classList.add('active');
  
  const btns = document.querySelectorAll('.btn-select-account');
  btns.forEach(b => {
    b.classList.remove('active');
    b.innerText = '查看详情';
  });
  
  const btnElem = document.getElementById(`btn-acc-${accountId}`);
  if (btnElem) {
    btnElem.classList.add('active');
    btnElem.innerText = '当前选中';
  }
  
  let name = '用户手动交易 (Manual)';
  if (accountId === 'A') name = '方案 A: 左侧低吸 (防守多)';
  else if (accountId === 'B') name = '方案 B: 右侧突破 (顺势多)';
  else if (accountId === 'C') name = '方案 C: 左侧高空 (防守空)';
  else if (accountId === 'D') name = '方案 D: 右侧破位 (顺势空)';
  
  document.getElementById('active-account-display-name').innerText = name;
  
  renderPortfolioUI();
}

// Matchmake Loop (both manual and backtest)
function matchmakeAllTokens() {
  if (!portfolio || !backtest) return;
  
  let stateChanged = false;
  
  // 1. Matchmake Manual Portfolio
  ['BTC', 'ETH'].forEach(token => {
    const subPort = portfolio[token];
    const price = token === 'BTC' ? btcPrice : ethPrice;
    if (!price || price <= 0) return;
    
    // Matchmake Pending Orders for this token
    for (let i = subPort.pendingOrders.length - 1; i >= 0; i--) {
      const order = subPort.pendingOrders[i];
      let isTriggered = false;
      
      if (order.direction === 'long') {
        if (order.type === 'limit') {
          if (price <= order.entryPrice) isTriggered = true;
        } else {
          if (price >= order.entryPrice) isTriggered = true;
        }
      } else {
        if (order.type === 'limit') {
          if (price >= order.entryPrice) isTriggered = true;
        } else {
          if (price <= order.entryPrice) isTriggered = true;
        }
      }
      
      if (isTriggered) {
        const newPos = {
          ...order,
          openTime: Date.now(),
          openPrice: order.entryPrice
        };
        delete newPos.createTime;
        delete newPos.type;
        
        subPort.activePositions.push(newPos);
        subPort.pendingOrders.splice(i, 1);
        stateChanged = true;
      }
    }
    
    // Matchmake Active Positions for this token
    for (let i = subPort.activePositions.length - 1; i >= 0; i--) {
      const pos = subPort.activePositions[i];
      let isClosed = false;
      let closePrice = 0;
      let reason = 'tp';
      
      const liqPrice = pos.direction === 'long' 
        ? pos.entryPrice * (1 - 1 / pos.margin)
        : pos.entryPrice * (1 + 1 / pos.margin);
        
      if (pos.direction === 'long') {
        if (price >= pos.tp) {
          isClosed = true;
          closePrice = pos.tp;
          reason = 'tp';
        } else if (price <= pos.sl) {
          isClosed = true;
          closePrice = pos.sl;
          reason = 'sl';
        } else if (price <= liqPrice && pos.margin > 1) {
          isClosed = true;
          closePrice = liqPrice;
          reason = 'liq';
        }
      } else {
        if (price <= pos.tp) {
          isClosed = true;
          closePrice = pos.tp;
          reason = 'tp';
        } else if (price >= pos.sl) {
          isClosed = true;
          closePrice = pos.sl;
          reason = 'sl';
        } else if (price >= liqPrice && pos.margin > 1) {
          isClosed = true;
          closePrice = liqPrice;
          reason = 'liq';
        }
      }
      
      if (isClosed) {
        const pnlResult = calculatePnL(pos, closePrice);
        subPort.balance += (pos.amount + pnlResult.pnl);
        
        const histItem = {
          id: 'hist-' + Date.now(),
          symbol: pos.symbol,
          setupName: pos.setupName,
          direction: pos.direction,
          entryPrice: pos.entryPrice,
          exitPrice: closePrice,
          amount: pos.amount,
          margin: pos.margin,
          pnl: pnlResult.pnl,
          pnlPercent: pnlResult.pnlPercent,
          closeTime: Date.now(),
          closeReason: reason
        };
        
        subPort.history.push(histItem);
        subPort.activePositions.splice(i, 1);
        stateChanged = true;
        
        alert(`[手动交易平仓提醒] 您的一笔手动持仓已平仓结清！\n币种: [${pos.symbol}] ${pos.direction === 'long' ? '做多' : '做空'}\n平仓原因: ${reason === 'tp' ? '止盈' : (reason === 'sl' ? '止损' : '爆仓强平')}\n已实现盈亏: ${pnlResult.pnl >= 0 ? '+' : ''}$${pnlResult.pnl.toFixed(2)} (${pnlResult.pnlPercent.toFixed(2)}%)`);
      }
    }
  });
  
  if (stateChanged) {
    savePortfolio();
  }
  
  // 2. Matchmake Auto-Backtest Portfolios
  let backtestChanged = false;
  
  ['A', 'B', 'C', 'D'].forEach(letter => {
    ['BTC', 'ETH'].forEach(token => {
      const port = backtest.portfolios[letter][token];
      const price = token === 'BTC' ? btcPrice : ethPrice;
      if (!price || price <= 0) return;
      
      if (port.pendingOrder !== null) {
        const order = port.pendingOrder;
        let isTriggered = false;
        
        if (order.direction === 'long') {
          if (order.type === 'limit') {
            if (price <= order.entryPrice) isTriggered = true;
          } else {
            if (price >= order.entryPrice) isTriggered = true;
          }
        } else {
          if (order.type === 'limit') {
            if (price >= order.entryPrice) isTriggered = true;
          } else {
            if (price <= order.entryPrice) isTriggered = true;
          }
        }
        
        if (isTriggered) {
          port.activePosition = {
            symbol: order.symbol,
            setupName: order.setupName,
            direction: order.direction,
            entryPrice: order.entryPrice,
            sl: order.sl,
            tp: order.tp,
            margin: order.margin,
            amount: order.amount,
            openTime: Date.now(),
            openPrice: order.entryPrice
          };
          port.pendingOrder = null;
          backtestChanged = true;
        }
      }
      
      if (port.activePosition !== null) {
        const pos = port.activePosition;
        let isClosed = false;
        let closePrice = 0;
        let reason = 'tp';
        
        const liqPrice = pos.direction === 'long' 
          ? pos.entryPrice * (1 - 1 / pos.margin)
          : pos.entryPrice * (1 + 1 / pos.margin);
          
        if (pos.direction === 'long') {
          if (price >= pos.tp) {
            isClosed = true;
            closePrice = pos.tp;
            reason = 'tp';
          } else if (price <= pos.sl) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (price <= liqPrice && pos.margin > 1) {
            isClosed = true;
            closePrice = liqPrice;
            reason = 'liq';
          }
        } else {
          if (price <= pos.tp) {
            isClosed = true;
            closePrice = pos.tp;
            reason = 'tp';
          } else if (price >= pos.sl) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (price >= liqPrice && pos.margin > 1) {
            isClosed = true;
            closePrice = liqPrice;
            reason = 'liq';
          }
        }
        
        if (isClosed) {
          const pnlResult = calculatePnL(pos, closePrice);
          port.balance += (pos.amount + pnlResult.pnl);
          
          const histItem = {
            id: 'hist-' + Date.now(),
            symbol: pos.symbol,
            setupName: pos.setupName,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            exitPrice: closePrice,
            amount: pos.amount,
            margin: pos.margin,
            pnl: pnlResult.pnl,
            pnlPercent: pnlResult.pnlPercent,
            closeTime: Date.now(),
            closeReason: reason
          };
          
          port.history.push(histItem);
          port.activePosition = null;
          backtestChanged = true;
        }
      }
    });
  });
  
  if (backtestChanged) {
    saveBacktest();
    renderBacktestComparisonTable();
  }
  
  renderPortfolioUI();
}

// Offline Historical K-Line Backfill Engine
async function triggerOfflineBackfill() {
  if (!portfolio || !backtest) return;
  
  const startSyncTime = portfolio.lastSyncTime;
  const currentReset = resetCounter;
  const now = Date.now();
  const timeDiff = now - portfolio.lastSyncTime;
  
  if (timeDiff < 120000) {
    portfolio.lastSyncTime = now;
    savePortfolio();
    return;
  }
  
  const symbolsToSync = new Set();
  
  // Scan Manual BTC and ETH
  ['BTC', 'ETH'].forEach(token => {
    if (portfolio[token]) {
      portfolio[token].pendingOrders.forEach(o => symbolsToSync.add(o.symbol));
      portfolio[token].activePositions.forEach(p => symbolsToSync.add(p.symbol));
    }
  });
  
  // Scan Backtest BTC and ETH for A, B, C, D
  ['A', 'B', 'C', 'D'].forEach(letter => {
    ['BTC', 'ETH'].forEach(token => {
      const port = backtest.portfolios[letter][token];
      if (port.pendingOrder) symbolsToSync.add(port.pendingOrder.symbol);
      if (port.activePosition) symbolsToSync.add(port.activePosition.symbol);
    });
  });
  
  if (symbolsToSync.size === 0) {
    // Check if reset occurred during check
    if (resetCounter !== currentReset) return;
    portfolio.lastSyncTime = now;
    savePortfolio();
    return;
  }
  
  // Adaptive K-line interval based on offline duration:
  // < 1 day   → 1m  (covers ≈ 25h at 1500 limit)
  // 1~7 days  → 1h  (covers ≈ 62 days at 1500 limit)
  // 7~30 days → 4h  (covers ≈ 250 days at 1500 limit)
  // > 30 days → 1d  (covers ≈ 4 years at 1500 limit)
  let interval = '1m';
  if (timeDiff > 30 * 86400000) {
    interval = '1d';
  } else if (timeDiff > 7 * 86400000) {
    interval = '4h';
  } else if (timeDiff > 86400000) {
    interval = '1h';
  }
  
  let totalOpened = 0;
  let totalClosed = 0;
  let totalBacktestOpened = 0;
  let totalBacktestClosed = 0;
  
  for (let symbol of symbolsToSync) {
    try {
      const klines = await fetchHistoricalKlines(symbol, interval, startSyncTime, now);
      if (klines && klines.length > 0) {
        // Double check reset before mutating
        if (resetCounter !== currentReset) return;
        
        // Align K-line timestamps to match the system's simulated clock (e.g. 2026)
        const latestExchangeTime = klines[klines.length - 1][0];
        const timeOffset = now - latestExchangeTime;
        const shiftedKlines = klines.map(k => [
          k[0] + timeOffset,
          k[1],
          k[2],
          k[3],
          k[4]
        ]);
        
        const result = processHistoricalKlines(symbol, shiftedKlines);
        totalOpened += result.opened;
        totalClosed += result.closed;
        totalBacktestOpened += result.backtestOpened;
        totalBacktestClosed += result.backtestClosed;
      }
    } catch (e) {
      console.error(`[Mock System] Failed to sync offline history for ${symbol}:`, e);
    }
  }
  
  // Prevent async race condition overwrite if the user clicked Reset during download
  if (resetCounter !== currentReset) {
    console.warn("[Offline Sync] Portfolio was reset during historical fetch. Aborting save.");
    return;
  }
  
  portfolio.lastSyncTime = now;
  backtest.lastSyncTime = now;
  savePortfolio();
  saveBacktest();
  
  // Recalculate and sync orders now that history is caught up
  runCalculator();
  
  renderBacktestComparisonTable();
  renderPortfolioUI();
  
  if (totalOpened > 0 || totalClosed > 0 || totalBacktestOpened > 0 || totalBacktestClosed > 0) {
    const banner = document.getElementById('sync-notification-banner');
    const bannerText = document.getElementById('sync-notification-text');
    if (banner && bannerText) {
      const days = (timeDiff / 86400000).toFixed(1);
      const durationStr = timeDiff < 86400000
        ? `${(timeDiff / 3600000).toFixed(1)} 小时`
        : `${days} 天`;
      bannerText.innerText = `检测到您曾离线 ${durationStr}（使用 ${interval} K线回溯）。系统已获取历史 K 线，自动为您撮合了 ${totalOpened} 笔挂单，平仓了 ${totalClosed} 笔持仓。后台 AI 回测系统同步撮合了 ${totalBacktestOpened} 笔挂单，平仓了 ${totalBacktestClosed} 笔持仓。`;
      banner.style.display = 'flex';
      setTimeout(() => {
        banner.style.display = 'none';
      }, 10000);
    }
  }
}

async function fetchHistoricalKlines(symbol, interval, startTime, endTime) {
  const timeDiff = endTime - startTime;
  // Map interval string to milliseconds for limit calculation
  const intervalMsMap = {
    '1m': 60000,
    '5m': 300000,
    '15m': 900000,
    '1h': 3600000,
    '4h': 14400000,
    '1d': 86400000
  };
  const intervalMs = intervalMsMap[interval] || 60000;
  
  // Max 1500 candles per request (Binance supports up to 1000, we cap here)
  const limit = Math.min(1500, Math.max(1, Math.ceil(timeDiff / intervalMs)));
  // Binance hard cap is 1000 per request
  const binanceLimit = Math.min(1000, limit);

  // Try Primary: Binance Vision Sandbox (CORS-enabled & GFW-free developer endpoint)
  try {
    const response = await fetchWithTimeout(`https://data-api.binance.vision/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${binanceLimit}`, { timeout: 5000 });
    if (response.ok) return await response.json();
  } catch (e) {
    console.warn(`Binance Vision klines failed for offline sync. Trying backup...`, e.message);
  }

  // Try Backup 1: Binance API
  try {
    const response = await fetchWithTimeout(`https://api.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${binanceLimit}`, { timeout: 5000 });
    if (response.ok) return await response.json();
  } catch (e) {
    console.warn(`Binance primary klines failed for offline sync. Trying backup...`, e.message);
  }
  
  // Try Backup 2: Binance API 3
  try {
    const response = await fetchWithTimeout(`https://api3.binance.com/api/v3/klines?symbol=${symbol}USDT&interval=${interval}&limit=${binanceLimit}`, { timeout: 5000 });
    if (response.ok) return await response.json();
  } catch (e) {
    console.warn(`Binance API3 klines failed for offline sync. Trying OKX fallback...`, e.message);
  }

  // Try Backup 3: OKX Candlesticks (supports up to 300 candles per request)
  try {
    // Map interval to OKX bar format
    const okxBarMap = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D' };
    const okxBar = okxBarMap[interval] || '1m';
    const okxLimit = Math.min(300, limit);
    const response = await fetchWithTimeout(`https://www.okx.com/api/v5/market/history-candles?instId=${symbol}-USDT&bar=${okxBar}&limit=${okxLimit}`, { timeout: 5000 });
    if (response.ok) {
      const rawData = await response.json();
      if (rawData && rawData.data && Array.isArray(rawData.data)) {
        const mapped = rawData.data.map(item => [
          parseInt(item[0]), // time in milliseconds
          parseFloat(item[1]), // open
          parseFloat(item[2]), // high
          parseFloat(item[3]), // low
          parseFloat(item[4])  // close
        ]);
        mapped.reverse();
        return mapped;
      }
    }
  } catch (e) {
    console.warn(`OKX fallback klines failed for offline sync.`, e.message);
  }
  
  return null;
}

function processHistoricalKlines(symbol, klines) {
  let opened = 0;
  let closed = 0;
  let backtestOpened = 0;
  let backtestClosed = 0;
  
  klines.sort((a, b) => a[0] - b[0]);
  
  for (let kline of klines) {
    const time = parseInt(kline[0]);
    const high = parseFloat(kline[2]);
    const low = parseFloat(kline[3]);
    
    // 1. Process Manual Portfolio
    const subPort = portfolio[symbol];
    if (subPort) {
      for (let i = subPort.pendingOrders.length - 1; i >= 0; i--) {
        const order = subPort.pendingOrders[i];
        if (order.symbol !== symbol) continue;
        
        let isTriggered = false;
        if (order.direction === 'long') {
          if (order.type === 'limit') {
            if (low <= order.entryPrice) isTriggered = true;
          } else {
            if (high >= order.entryPrice) isTriggered = true;
          }
        } else {
          if (order.type === 'limit') {
            if (high >= order.entryPrice) isTriggered = true;
          } else {
            if (low <= order.entryPrice) isTriggered = true;
          }
        }
        
        if (isTriggered) {
          const newPos = {
            ...order,
            openTime: time,
            openPrice: order.entryPrice
          };
          delete newPos.createTime;
          delete newPos.type;
          
          subPort.activePositions.push(newPos);
          subPort.pendingOrders.splice(i, 1);
          opened++;
        }
      }
      
      for (let i = subPort.activePositions.length - 1; i >= 0; i--) {
        const pos = subPort.activePositions[i];
        if (pos.symbol !== symbol) continue;
        
        let isClosed = false;
        let closePrice = 0;
        let reason = 'tp';
        
        const liqPrice = pos.direction === 'long' 
          ? pos.entryPrice * (1 - 1 / pos.margin)
          : pos.entryPrice * (1 + 1 / pos.margin);
          
        if (pos.direction === 'long') {
          const hitTP = high >= pos.tp;
          const hitSL = low <= pos.sl;
          const hitLiq = low <= liqPrice && pos.margin > 1;
          
          if (hitTP && hitSL) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (hitLiq) {
            isClosed = true;
            closePrice = liqPrice;
            reason = 'liq';
          } else if (hitSL) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (hitTP) {
            isClosed = true;
            closePrice = pos.tp;
            reason = 'tp';
          }
        } else {
          const hitTP = low <= pos.tp;
          const hitSL = high >= pos.sl;
          const hitLiq = high >= liqPrice && pos.margin > 1;
          
          if (hitTP && hitSL) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (hitLiq) {
            isClosed = true;
            closePrice = liqPrice;
            reason = 'liq';
          } else if (hitSL) {
            isClosed = true;
            closePrice = pos.sl;
            reason = 'sl';
          } else if (hitTP) {
            isClosed = true;
            closePrice = pos.tp;
            reason = 'tp';
          }
        }
        
        if (isClosed) {
          const pnlResult = calculatePnL(pos, closePrice);
          subPort.balance += (pos.amount + pnlResult.pnl);
          
          const histItem = {
            id: 'hist-' + time,
            symbol: pos.symbol,
            setupName: pos.setupName,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            exitPrice: closePrice,
            amount: pos.amount,
            margin: pos.margin,
            pnl: pnlResult.pnl,
            pnlPercent: pnlResult.pnlPercent,
            closeTime: time,
            closeReason: reason
          };
          
          subPort.history.push(histItem);
          subPort.activePositions.splice(i, 1);
          closed++;
        }
      }
    }
    
    // 2. Process Auto-Backtest Portfolios
    ['A', 'B', 'C', 'D'].forEach(letter => {
      const port = backtest.portfolios[letter][symbol];
      if (port) {
        if (port.pendingOrder !== null && port.pendingOrder.symbol === symbol) {
          const order = port.pendingOrder;
          let isTriggered = false;
          
          if (order.direction === 'long') {
            if (order.type === 'limit') {
              if (low <= order.entryPrice) isTriggered = true;
            } else {
              if (high >= order.entryPrice) isTriggered = true;
            }
          } else {
            if (order.type === 'limit') {
              if (high >= order.entryPrice) isTriggered = true;
            } else {
              if (low <= order.entryPrice) isTriggered = true;
            }
          }
          
          if (isTriggered) {
            port.activePosition = {
              symbol: order.symbol,
              setupName: order.setupName,
              direction: order.direction,
              entryPrice: order.entryPrice,
              sl: order.sl,
              tp: order.tp,
              margin: order.margin,
              amount: order.amount,
              openTime: time,
              openPrice: order.entryPrice
            };
            port.pendingOrder = null;
            backtestOpened++;
          }
        }
        
        if (port.activePosition !== null && port.activePosition.symbol === symbol) {
          const pos = port.activePosition;
          let isClosed = false;
          let closePrice = 0;
          let reason = 'tp';
          
          const liqPrice = pos.direction === 'long' 
            ? pos.entryPrice * (1 - 1 / pos.margin)
            : pos.entryPrice * (1 + 1 / pos.margin);
            
          if (pos.direction === 'long') {
            const hitTP = high >= pos.tp;
            const hitSL = low <= pos.sl;
            const hitLiq = low <= liqPrice && pos.margin > 1;
            
            if (hitTP && hitSL) {
              isClosed = true;
              closePrice = pos.sl;
              reason = 'sl';
            } else if (hitLiq) {
              isClosed = true;
              closePrice = liqPrice;
              reason = 'liq';
            } else if (hitSL) {
              isClosed = true;
              closePrice = pos.sl;
              reason = 'sl';
            } else if (hitTP) {
              isClosed = true;
              closePrice = pos.tp;
              reason = 'tp';
            }
          } else {
            const hitTP = low <= pos.tp;
            const hitSL = high >= pos.sl;
            const hitLiq = high >= liqPrice && pos.margin > 1;
            
            if (hitTP && hitSL) {
              isClosed = true;
              closePrice = pos.sl;
              reason = 'sl';
            } else if (hitLiq) {
              isClosed = true;
              closePrice = liqPrice;
              reason = 'liq';
            } else if (hitSL) {
              isClosed = true;
              closePrice = pos.sl;
              reason = 'sl';
            } else if (hitTP) {
              isClosed = true;
              closePrice = pos.tp;
              reason = 'tp';
            }
          }
          
          if (isClosed) {
            const pnlResult = calculatePnL(pos, closePrice);
            port.balance += (pos.amount + pnlResult.pnl);
            
            const histItem = {
              id: 'hist-' + time,
              symbol: pos.symbol,
              setupName: pos.setupName,
              direction: pos.direction,
              entryPrice: pos.entryPrice,
              exitPrice: closePrice,
              amount: pos.amount,
              margin: pos.margin,
              pnl: pnlResult.pnl,
              pnlPercent: pnlResult.pnlPercent,
              closeTime: time,
              closeReason: reason
            };
            
            port.history.push(histItem);
            port.activePosition = null;
            backtestClosed++;
          }
        }
      }
    });
  }
  
  return { opened, closed, backtestOpened, backtestClosed };
}

// Render Backtest Comparison Dashboard
function renderBacktestComparisonTable() {
  if (!portfolio || !backtest) return;

  const accounts = ['manual', 'A', 'B', 'C', 'D'];
  accounts.forEach(accId => {
    let balance = 0;
    let history = [];
    let statusText = '--';
    let totalAssets = 0;
    let realizedPnL = 0;
    let winCount = 0;
    let lossCount = 0;

    if (accId === 'manual') {
      const subPort = portfolio[activeToken];
      if (subPort) {
        balance = subPort.balance;
        history = subPort.history;
        
        let totalAssetsSum = 0;
        ['BTC', 'ETH'].forEach(token => {
          const tPort = portfolio[token];
          if (tPort) {
            let pendingAmt = tPort.pendingOrders.reduce((sum, o) => sum + o.amount, 0);
            let activeAmt = tPort.activePositions.reduce((sum, p) => sum + p.amount, 0);
            let activeUnrealized = tPort.activePositions.reduce((sum, p) => {
              const price = p.symbol === 'BTC' ? btcPrice : ethPrice;
              if (price && price > 0) {
                return sum + calculatePnL(p, price).pnl;
              }
              return 0;
            }, 0);
            totalAssetsSum += tPort.balance + pendingAmt + activeAmt + activeUnrealized;
          }
        });
        totalAssets = totalAssetsSum;
        
        if (subPort.activePositions.length > 0 && subPort.pendingOrders.length > 0) {
          statusText = `${subPort.activePositions.length} 持仓 | ${subPort.pendingOrders.length} 挂单`;
        } else if (subPort.activePositions.length > 0) {
          statusText = `${subPort.activePositions.length} 笔持仓`;
        } else if (subPort.pendingOrders.length > 0) {
          statusText = `${subPort.pendingOrders.length} 笔挂单`;
        } else {
          statusText = '空仓';
        }
      }
    } else {
      const port = backtest.portfolios[accId][activeToken];
      if (port) {
        balance = port.balance;
        history = port.history;
        
        let totalAssetsSum = 0;
        ['BTC', 'ETH'].forEach(token => {
          const tPort = backtest.portfolios[accId][token];
          if (tPort) {
            let unrealized = 0;
            if (tPort.activePosition) {
              const pos = tPort.activePosition;
              const price = pos.symbol === 'BTC' ? btcPrice : ethPrice;
              if (price && price > 0) {
                unrealized = calculatePnL(pos, price).pnl;
              }
              totalAssetsSum += tPort.balance + pos.amount + unrealized;
            } else if (tPort.pendingOrder) {
              totalAssetsSum += tPort.balance + tPort.pendingOrder.amount;
            } else {
              totalAssetsSum += tPort.balance;
            }
          }
        });
        totalAssets = totalAssetsSum;

        if (port.activePosition) {
          const pos = port.activePosition;
          const price = pos.symbol === 'BTC' ? btcPrice : ethPrice;
          if (price && price > 0) {
            const pnlResult = calculatePnL(pos, price);
            const pnlSign = pnlResult.pnl >= 0 ? '+' : '';
            statusText = `持仓中 (${pnlSign}${pnlResult.pnlPercent.toFixed(1)}%)`;
          } else {
            statusText = `持仓中`;
          }
        } else if (port.pendingOrder) {
          statusText = `已挂单 @ $${port.pendingOrder.entryPrice.toLocaleString()}`;
        } else {
          statusText = '空仓';
        }
      }
    }

    // Calculate Realized PnL and Win Rate for active token
    realizedPnL = history.reduce((sum, item) => sum + item.pnl, 0);
    history.forEach(item => {
      if (item.pnl > 0) winCount++;
      else if (item.pnl < 0) lossCount++;
    });
    const totalTrades = winCount + lossCount;
    const winRate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;

    // Update DOM elements
    const balanceElem = document.getElementById(`backtest-balance-${accId}`);
    const pnlElem = document.getElementById(`backtest-pnl-${accId}`);
    const winrateElem = document.getElementById(`backtest-winrate-${accId}`);
    const statusElem = document.getElementById(`backtest-status-${accId}`);

    if (balanceElem) {
      balanceElem.innerText = `$${totalAssets.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }
    if (pnlElem) {
      pnlElem.innerText = `${realizedPnL >= 0 ? '+' : ''}$${realizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      pnlElem.style.color = realizedPnL >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
      pnlElem.style.fontWeight = '700';
    }
    if (winrateElem) {
      winrateElem.innerText = `${winRate.toFixed(1)}% (${winCount}/${totalTrades})`;
    }
    if (statusElem) {
      statusElem.innerText = statusText;
      if (statusText.includes('持仓中')) {
        statusElem.style.color = 'var(--color-success)';
        statusElem.style.fontWeight = '700';
      } else if (statusText.includes('已挂单')) {
        statusElem.style.color = 'var(--color-warning)';
        statusElem.style.fontWeight = 'normal';
      } else {
        statusElem.style.color = 'var(--color-text-muted)';
        statusElem.style.fontWeight = 'normal';
      }
    }
  });
}

// Rendering UI Helpers
function renderPortfolioUI() {
  if (!portfolio || !backtest) return;
  
  let currentPortfolio = null;
  if (activeAccountId === 'manual') {
    currentPortfolio = portfolio[activeToken];
  } else {
    currentPortfolio = backtest.portfolios[activeAccountId][activeToken];
  }
  if (!currentPortfolio) return;
  
  document.getElementById('port-total-balance').innerText = `$${currentPortfolio.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  
  updateRealtimeUnrealizedPnL();
  
  let netRealized = 0;
  let winCount = 0;
  let lossCount = 0;
  
  currentPortfolio.history.forEach(item => {
    netRealized += item.pnl;
    if (item.pnl > 0) winCount++;
    else if (item.pnl < 0) lossCount++;
  });
  
  const portRealized = document.getElementById('port-realized-pnl');
  if (portRealized) {
    portRealized.innerText = `${netRealized >= 0 ? '+' : ''}$${netRealized.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    portRealized.style.color = netRealized >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
  }
  
  const portWinrate = document.getElementById('port-winrate');
  if (portWinrate) {
    const totalTrades = winCount + lossCount;
    const rate = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
    portWinrate.innerText = `${rate.toFixed(1)}% (${winCount}/${totalTrades})`;
  }
  
  // Pending Orders Table
  const pendingTbody = document.getElementById('pending-orders-tbody');
  if (pendingTbody) {
    let orders = [];
    if (activeAccountId === 'manual') {
      orders = currentPortfolio.pendingOrders;
    } else {
      orders = currentPortfolio.pendingOrder ? [currentPortfolio.pendingOrder] : [];
    }
    
    if (orders.length === 0) {
      pendingTbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">暂无活跃挂单</td></tr>`;
    } else {
      pendingTbody.innerHTML = '';
      orders.forEach(order => {
        const cancelAction = `cancelPendingOrder('${order.id || activeAccountId}')`;
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>[${order.symbol}]</strong> ${order.setupName}</td>
          <td><span class="table-${order.direction === 'long' ? 'rec' : 'short'}-badge" style="font-size:0.75rem; padding:0.15rem 0.4rem; border-radius:6px;">${order.direction === 'long' ? '多' : '空'}</span></td>
          <td class="setup-val">$${order.entryPrice.toLocaleString()}</td>
          <td class="setup-val"><span class="text-danger">$${order.sl.toLocaleString()}</span> / <span class="text-success">$${order.tp.toLocaleString()}</span></td>
          <td>${order.type === 'limit' ? '左侧限价' : '右侧破位/突破'}</td>
          <td class="setup-val">${order.margin}x / 保证金 $${order.amount.toFixed(2)} (持仓 $${(order.amount * order.margin).toFixed(2)})</td>
          <td><button class="btn-cancel-order" onclick="${cancelAction}">撤单</button></td>
        `;
        pendingTbody.appendChild(tr);
      });
    }
  }
  
  // History Closed Trades Table
  const historyTbody = document.getElementById('trade-history-tbody');
  if (historyTbody) {
    if (currentPortfolio.history.length === 0) {
      historyTbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">暂无历史交易记录</td></tr>`;
    } else {
      const sortedHistory = [...currentPortfolio.history].sort((a, b) => b.closeTime - a.closeTime);
      historyTbody.innerHTML = '';
      sortedHistory.forEach(item => {
        const dateStr = new Date(item.closeTime).toLocaleString();
        const pnlSign = item.pnl >= 0 ? '+' : '';
        const pnlColor = item.pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
        const reasonCN = item.closeReason === 'tp' ? '止盈' : (item.closeReason === 'sl' ? '止损' : (item.closeReason === 'liq' ? '强平爆仓' : '手动平仓'));
        const reasonColor = item.closeReason === 'tp' ? 'var(--color-success)' : (item.closeReason === 'sl' ? 'var(--color-danger)' : (item.closeReason === 'liq' ? 'var(--color-danger)' : 'var(--color-text-muted)'));
        
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="text-muted" style="font-size:0.75rem;">${dateStr}</td>
          <td><strong>[${item.symbol}]</strong> ${item.setupName}</td>
          <td><span class="table-${item.direction === 'long' ? 'rec' : 'short'}-badge" style="font-size:0.75rem; padding:0.15rem 0.4rem; border-radius:6px;">${item.direction === 'long' ? '多' : '空'}</span></td>
          <td class="setup-val">$${item.entryPrice.toLocaleString()} / $${item.exitPrice.toLocaleString()}</td>
          <td class="setup-val" style="color:${pnlColor}; font-weight:700;">${pnlSign}${item.pnlPercent.toFixed(2)}%</td>
          <td class="setup-val" style="color:${pnlColor}; font-weight:700;">${pnlSign}$${item.pnl.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
          <td style="color:${reasonColor}; font-weight:700;">${reasonCN}</td>
        `;
        historyTbody.appendChild(tr);
      });
    }
  }
}

function updateRealtimeUnrealizedPnL() {
  if (!portfolio || !backtest) return;
  
  let currentPortfolio = null;
  if (activeAccountId === 'manual') {
    currentPortfolio = portfolio[activeToken];
  } else {
    currentPortfolio = backtest.portfolios[activeAccountId][activeToken];
  }
  if (!currentPortfolio) return;
  
  let totalUnrealizedPnL = 0;
  let totalInvested = 0;
  
  const positionsTbody = document.getElementById('active-positions-tbody');
  
  if (positionsTbody) {
    let positions = [];
    if (activeAccountId === 'manual') {
      positions = currentPortfolio.activePositions;
    } else {
      positions = currentPortfolio.activePosition ? [currentPortfolio.activePosition] : [];
    }
    
    if (positions.length === 0) {
      positionsTbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">暂无活跃持仓</td></tr>`;
    } else {
      positionsTbody.innerHTML = '';
      positions.forEach(pos => {
        const price = pos.symbol === 'BTC' ? btcPrice : ethPrice;
        if (!price || price <= 0) return;
        
        const pnlResult = calculatePnL(pos, price);
        totalUnrealizedPnL += pnlResult.pnl;
        totalInvested += pos.amount;
        
        const pnlSign = pnlResult.pnl >= 0 ? '+' : '';
        const pnlColor = pnlResult.pnl >= 0 ? 'var(--color-success)' : 'var(--color-danger)';
        
        const closeAction = `closeActivePosition('${pos.id || activeAccountId}')`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>[${pos.symbol}]</strong> ${pos.setupName}</td>
          <td><span class="table-${pos.direction === 'long' ? 'rec' : 'short'}-badge" style="font-size:0.75rem; padding:0.15rem 0.4rem; border-radius:6px;">${pos.direction === 'long' ? '多' : '空'}</span></td>
          <td class="setup-val">$${pos.entryPrice.toLocaleString()}</td>
          <td class="setup-val cyan">$${price.toLocaleString()}</td>
          <td class="setup-val"><span class="text-danger">$${pos.sl.toLocaleString()}</span> / <span class="text-success">$${pos.tp.toLocaleString()}</span></td>
          <td class="setup-val" style="color:${pnlColor}; font-weight:700;">${pnlSign}$${pnlResult.pnl.toFixed(2)} (${pnlSign}${pnlResult.pnlPercent.toFixed(2)}%)</td>
          <td><button class="btn-close-pos" onclick="${closeAction}">市价平仓</button></td>
        `;
        positionsTbody.appendChild(tr);
      });
    }
  }
  
  const unrealizedElem = document.getElementById('port-unrealized-pnl');
  if (unrealizedElem) {
    const pnlSign = totalUnrealizedPnL >= 0 ? '+' : '';
    const pnlPercent = totalInvested > 0 ? (totalUnrealizedPnL / totalInvested) * 100 : 0;
    unrealizedElem.innerText = `${pnlSign}$${totalUnrealizedPnL.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} (${pnlSign}${pnlPercent.toFixed(2)}%)`;
    unrealizedElem.style.color = totalUnrealizedPnL >= 0 ? 'var(--color-success)' : (totalUnrealizedPnL < 0 ? 'var(--color-danger)' : 'var(--color-text-main)');
  }
}


