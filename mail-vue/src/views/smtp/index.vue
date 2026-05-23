<template>
  <el-scrollbar style="height: 100%;">
    <div class="smtp-page">
      <section class="toolbar">
        <div>
          <h2>SMTP API</h2>
          <p>发送状态与统计</p>
        </div>
        <div class="toolbar-actions">
          <el-input
              v-model="tokenInput"
              type="password"
              show-password
              placeholder="SMTP API Token"
              clearable
              class="token-input"
          />
          <el-button type="primary" :icon="Refresh" @click="saveTokenAndLoad">刷新</el-button>
        </div>
      </section>

      <section class="metric-grid">
        <div class="metric">
          <div class="metric-label">总请求</div>
          <div class="metric-value">{{ stats.total || 0 }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">发送成功</div>
          <div class="metric-value success">{{ stats.sent || 0 }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">发送失败</div>
          <div class="metric-value danger">{{ stats.failed || 0 }}</div>
        </div>
        <div class="metric">
          <div class="metric-label">今日请求</div>
          <div class="metric-value">{{ stats.today || 0 }}</div>
        </div>
      </section>

      <section class="content-grid">
        <div class="panel">
          <div class="panel-title">近 14 天</div>
          <div class="day-list">
            <div v-for="day in stats.byDay" :key="day.date" class="day-row">
              <span>{{ day.date.slice(5) }}</span>
              <div class="day-bar">
                <i class="sent" :style="{width: barWidth(day.sent)}"></i>
                <i class="failed" :style="{width: barWidth(day.failed)}"></i>
              </div>
              <strong>{{ day.total }}</strong>
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-title">测试发送</div>
          <el-form label-position="top" class="send-form">
            <el-form-item label="收件人">
              <el-input v-model="sendForm.to" placeholder="user@example.com" />
            </el-form-item>
            <el-form-item label="主题">
              <el-input v-model="sendForm.subject" placeholder="Cloud Mail SMTP API test" />
            </el-form-item>
            <el-form-item label="正文">
              <el-input v-model="sendForm.text" type="textarea" :rows="5" />
            </el-form-item>
            <el-button type="primary" :icon="Promotion" :loading="sending" @click="sendTest">
              发送测试
            </el-button>
          </el-form>
        </div>
      </section>

      <section class="panel">
        <div class="table-head">
          <div class="panel-title">发送记录</div>
          <div class="table-tools">
            <el-select v-model="query.status" clearable placeholder="状态" style="width: 130px" @change="reloadMessages">
              <el-option label="sent" value="sent" />
              <el-option label="failed" value="failed" />
              <el-option label="queued" value="queued" />
            </el-select>
            <el-input
                v-model="query.q"
                clearable
                placeholder="搜索邮箱/主题/ID"
                style="width: 220px"
                @keyup.enter="reloadMessages"
                @clear="reloadMessages"
            />
            <el-button :icon="Refresh" @click="loadAll">刷新</el-button>
          </div>
        </div>
        <el-table :data="messages" v-loading="loading" style="width: 100%">
          <el-table-column prop="createdAt" label="时间" min-width="170">
            <template #default="{row}">
              {{ formatTime(row.createdAt) }}
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="110">
            <template #default="{row}">
              <el-tag :type="statusType(row.status)" effect="light">{{ row.status }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="from" label="发件人" min-width="180" show-overflow-tooltip />
          <el-table-column label="收件人" min-width="220" show-overflow-tooltip>
            <template #default="{row}">
              {{ (row.to || []).join(', ') }}
            </template>
          </el-table-column>
          <el-table-column prop="subject" label="主题" min-width="220" show-overflow-tooltip />
          <el-table-column prop="error" label="错误" min-width="220" show-overflow-tooltip />
        </el-table>
        <div class="pager">
          <el-pagination
              layout="prev, pager, next, total"
              :total="total"
              :page-size="query.pageSize"
              v-model:current-page="query.page"
              @current-change="reloadMessages"
          />
        </div>
      </section>
    </div>
  </el-scrollbar>
</template>

<script setup>
import { onMounted, reactive, ref } from 'vue';
import { Promotion, Refresh } from '@element-plus/icons-vue';
import dayjs from 'dayjs';
import { smtpMessages, smtpSend, smtpStats } from '@/request/smtp.js';

defineOptions({
  name: 'smtp'
});

const tokenInput = ref(localStorage.getItem('smtpApiToken') || '');
const stats = reactive({
  total: 0,
  sent: 0,
  failed: 0,
  queued: 0,
  today: 0,
  byDay: []
});
const query = reactive({
  page: 1,
  pageSize: 20,
  status: '',
  q: ''
});
const messages = ref([]);
const total = ref(0);
const loading = ref(false);
const sending = ref(false);
const sendForm = reactive({
  to: '',
  subject: 'Cloud Mail SMTP API test',
  text: 'Hello from Cloud Mail SMTP API.'
});

onMounted(() => {
  if (tokenInput.value) {
    loadAll();
  }
});

function currentToken() {
  return tokenInput.value.trim();
}

function saveTokenAndLoad() {
  localStorage.setItem('smtpApiToken', currentToken());
  loadAll();
}

async function loadAll() {
  await loadStats().catch(showApiError);
  await loadMessages().catch(showApiError);
}

async function loadStats() {
  if (!currentToken()) return;
  const data = await smtpStats(currentToken(), 14);
  Object.assign(stats, data);
}

async function loadMessages() {
  if (!currentToken()) return;
  loading.value = true;
  try {
    const data = await smtpMessages(currentToken(), query);
    messages.value = data.list;
    total.value = data.total;
  } finally {
    loading.value = false;
  }
}

function reloadMessages() {
  loadMessages().catch(showApiError);
}

async function sendTest() {
  if (!currentToken()) {
    ElMessage.warning('请先填写 SMTP API Token');
    return;
  }
  if (!sendForm.to || !sendForm.text) {
    ElMessage.warning('请填写收件人和正文');
    return;
  }
  sending.value = true;
  try {
    await smtpSend(currentToken(), {
      to: sendForm.to,
      subject: sendForm.subject,
      text: sendForm.text
    });
    ElMessage.success('发送请求已提交');
    await loadAll();
  } catch (error) {
    showApiError(error);
  } finally {
    sending.value = false;
  }
}

function showApiError(error) {
  const message = error?.response?.data?.message || error?.response?.data?.error || error.message || 'SMTP API 请求失败';
  ElMessage.error(message);
}

function statusType(status) {
  if (status === 'sent') return 'success';
  if (status === 'failed') return 'danger';
  return 'warning';
}

function formatTime(value) {
  return value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '';
}

function barWidth(value) {
  const max = Math.max(1, ...stats.byDay.map(day => day.total || 0));
  return `${Math.max(0, Math.round((value || 0) / max * 100))}%`;
}
</script>

<style scoped lang="scss">
.smtp-page {
  min-height: 100%;
  padding: 20px;
  background: var(--extra-light-fill);
  display: grid;
  gap: 16px;
}

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;

  h2 {
    margin: 0;
    font-size: 22px;
  }

  p {
    margin: 4px 0 0;
    color: var(--el-text-color-secondary);
  }
}

.toolbar-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.token-input {
  width: min(420px, 50vw);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.metric,
.panel {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
}

.metric {
  padding: 18px;
}

.metric-label {
  color: var(--el-text-color-secondary);
  font-size: 14px;
}

.metric-value {
  margin-top: 8px;
  font-size: 28px;
  font-weight: 700;
}

.success {
  color: var(--el-color-success);
}

.danger {
  color: var(--el-color-danger);
}

.content-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(320px, 0.8fr);
  gap: 16px;
}

.panel {
  padding: 16px;
}

.panel-title {
  font-size: 16px;
  font-weight: 700;
  margin-bottom: 14px;
}

.day-list {
  display: grid;
  gap: 10px;
}

.day-row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 40px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.day-bar {
  height: 10px;
  border-radius: 999px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  display: flex;

  i {
    display: block;
    height: 100%;
  }

  .sent {
    background: var(--el-color-success);
  }

  .failed {
    background: var(--el-color-danger);
  }
}

.send-form {
  :deep(.el-form-item) {
    margin-bottom: 12px;
  }
}

.table-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: center;
}

.table-tools {
  display: flex;
  gap: 10px;
  align-items: center;
}

.pager {
  display: flex;
  justify-content: flex-end;
  padding-top: 14px;
}

@media (max-width: 1024px) {
  .toolbar,
  .table-head,
  .toolbar-actions,
  .table-tools {
    align-items: stretch;
    flex-direction: column;
  }

  .token-input,
  .table-tools :deep(.el-input),
  .table-tools :deep(.el-select) {
    width: 100% !important;
  }

  .metric-grid,
  .content-grid {
    grid-template-columns: 1fr;
  }
}
</style>
