// scripts/build-china-regions.mjs
// 生成 web/js/china-regions.json（设置页城市选择器用，省 → 市 → 区县，只留名字）。
// 数据源：https://github.com/modood/Administrative-divisions-of-China (MIT) dist/pca.json
// 用法：node memory_service/scripts/build-china-regions.mjs
// 行政区划变动后重跑即可；产物随仓库提交，运行时不联网。

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL =
    'https://raw.githubusercontent.com/modood/Administrative-divisions-of-China/master/dist/pca.json';

// 数据源不含港澳台，这里补到城市级（区县不全，够天气用）
const EXTRA_PROVINCES = [
    {
        name: '香港特别行政区',
        cities: [
            {
                name: '香港特别行政区',
                areas: [
                    '中西区', '湾仔区', '东区', '南区', '油尖旺区', '深水埗区', '九龙城区', '黄大仙区',
                    '观塘区', '荃湾区', '屯门区', '元朗区', '北区', '大埔区', '西贡区', '沙田区',
                    '葵青区', '离岛区',
                ],
            },
        ],
    },
    {
        name: '澳门特别行政区',
        cities: [{ name: '澳门特别行政区', areas: ['澳门半岛', '氹仔', '路环'] }],
    },
    {
        name: '台湾省',
        cities: [
            { name: '台北市', areas: [] },
            { name: '新北市', areas: [] },
            { name: '桃园市', areas: [] },
            { name: '台中市', areas: [] },
            { name: '台南市', areas: [] },
            { name: '高雄市', areas: [] },
            { name: '基隆市', areas: [] },
            { name: '新竹市', areas: [] },
            { name: '嘉义市', areas: [] },
            { name: '宜兰县', areas: [] },
            { name: '花莲县', areas: [] },
            { name: '台东县', areas: [] },
            { name: '屏东县', areas: [] },
            { name: '南投县', areas: [] },
            { name: '彰化县', areas: [] },
            { name: '云林县', areas: [] },
            { name: '苗栗县', areas: [] },
            { name: '澎湖县', areas: [] },
            { name: '金门县', areas: [] },
            { name: '连江县', areas: [] },
        ],
    },
];

const MUNICIPALITIES = new Set(['北京市', '天津市', '上海市', '重庆市']);
// 省直辖县级单位：合并成一个伪「市」分组
const DIRECT_COUNTY_KEYS = new Set(['市辖区', '县', '省直辖县级行政区划', '自治区直辖县级行政区划']);

function uniq(list) {
    return [...new Set(list)];
}

function normalizeProvince(provinceName, cities) {
    const merged = [];
    const directCounties = [];
    for (const [cityName, areas] of Object.entries(cities)) {
        if (DIRECT_COUNTY_KEYS.has(cityName)) {
            directCounties.push(...(Array.isArray(areas) ? areas : []));
        } else {
            merged.push({ name: cityName, areas: uniq(Array.isArray(areas) ? areas : []) });
        }
    }
    if (directCounties.length) {
        if (MUNICIPALITIES.has(provinceName)) {
            // 直辖市：区县直接挂在省下，UI 会跳过「市」这一层
            merged.unshift({ name: provinceName, areas: uniq(directCounties) });
        } else {
            merged.push({ name: '省直辖县', areas: uniq(directCounties), direct: true });
        }
    }
    return { name: provinceName, cities: merged };
}

async function main() {
    const resp = await fetch(SOURCE_URL, { headers: { 'User-Agent': 'tidal-build-regions' } });
    if (!resp.ok) throw new Error(`下载失败: HTTP ${resp.status}`);
    const raw = await resp.json();

    const provinces = Object.entries(raw).map(([name, cities]) => normalizeProvince(name, cities || {}));
    provinces.push(...EXTRA_PROVINCES);

    const out = {
        _meta: {
            source: 'https://github.com/modood/Administrative-divisions-of-China',
            license: 'MIT',
            generated_at: new Date().toISOString().slice(0, 10),
            levels: 'province > city > area',
            note: '只保留行政区划名称；天气按 省 市 区 拼接查询。',
        },
        provinces,
    };

    const outPath = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../../web/js/china-regions.json',
    );
    await writeFile(outPath, JSON.stringify(out), 'utf8');

    const cityCount = provinces.reduce((n, p) => n + p.cities.length, 0);
    const areaCount = provinces.reduce(
        (n, p) => n + p.cities.reduce((m, c) => m + c.areas.length, 0),
        0,
    );
    console.log(`[OK] ${outPath}`);
    console.log(`[OK] 省 ${provinces.length} / 市 ${cityCount} / 区县 ${areaCount}`);
}

main().catch((e) => {
    console.error('[FAIL]', e.message);
    process.exit(1);
});
