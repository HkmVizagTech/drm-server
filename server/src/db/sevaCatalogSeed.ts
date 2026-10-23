// The seva structure the donation sites' DCC API understands, as the temple sent it.
//
// TRANSCRIBED FROM SCREENSHOTS OF THE TEMPLE'S SHEET, so it is only as good as the
// reading. Two rows - Sankranti, sub-seva ids 144 and 145 - were cut off in the
// screenshots and are NOT here; they are added by uploading the real sheet in
// DRM (Seva categories > Import). That upload also checks every row below against
// the sheet and reports any that differ, so a misread value is found and fixed
// there rather than quietly sent to DCC.
//
// One entry per Seva Sub Category; `subs` are its Seva Sub Codes as
// [name, SevaSubCategoryCodeId, IsTaxExempted]. Sub categories with no sub codes
// have `subs: null` and `tax: null`.

export interface SeedGroup {
  category: string;
  categoryId: number;
  subCategory: string;
  subCategoryId: number;
  code: string;
  subs: [name: string, codeId: number, tax: 0 | 1 | null][] | null;
}

const CP = 'Cultural Program';
const PD = 'Patron Donation';
const GD = 'General Donation';

export const SEVA_SEED: SeedGroup[] = [
  { category: 'Annadanam', categoryId: 1, subCategory: 'Annadanam General', subCategoryId: 1, code: 'ANGE', subs: null },
  { category: 'Annadanam', categoryId: 1, subCategory: 'Covid Relief Kits', subCategoryId: 2, code: 'CRK', subs: null },
  { category: GD, categoryId: 2, subCategory: 'General Donation', subCategoryId: 3, code: 'GDGD', subs: null },
  { category: GD, categoryId: 2, subCategory: 'General Donation RT', subCategoryId: 4, code: 'GDRT', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Deepotsava', subCategoryId: 5, code: 'DEEP', subs: [
    ['Annadana Seva', 1, 1], ['Mandapa Seva', 2, 0], ['Pushpalankara Seva', 3, 0], ['Yajamana Seva', 4, 0],
    ['Deepalankara Seva', 5, 0], ['Abhisheka Seva', 47, 0], ['Gau Seva', 130, 1], ['Deeparadhana Seva', 90, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Govardhan Puja', subCategoryId: 6, code: 'GOVP', subs: [
    ['Gau Seva', 131, 1], ['Abhisheka Seva', 48, 0], ['Deeparadhana Seva', 78, 0], ['Naivedya Seva', 79, 0],
    ['Vastrabharana Seva', 80, 0], ['Annadana Seva', 6, 1], ['Mandapa Seva', 7, 0], ['Pushpalankara Seva', 8, 0],
    ['Yajamana Seva', 9, 0], ['Deepalankara Seva', 10, 0], ['Annakuta Seva', 11, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Narasimha Jayanthi', subCategoryId: 7, code: 'NARJ', subs: [
    ['Annadana Seva', 12, 1], ['Mandapa Seva', 13, 0], ['Pushpalankara Seva', 14, 0], ['Yajamana Seva', 15, 0],
    ['Narasimha Kavaca Seva', 16, 0], ['Abhisheka Seva', 49, 0], ['Gau Seva', 132, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Panihatti Chida Dahi Utsava', subCategoryId: 8, code: 'PANI', subs: [
    ['Gau Seva', 133, 1], ['Annadana Seva', 17, 1], ['Mandapa Seva', 18, 0], ['Pushpalankara Seva', 19, 0],
    ['Yajamana Seva', 20, 0], ['Abhisheka Seva', 21, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Sri Gaura Poornima', subCategoryId: 9, code: 'GAUR', subs: [
    ['Annadana Seva', 22, 1], ['Mandapa Seva', 23, 0], ['Pushpalankara Seva', 24, 0], ['Yajamana Seva', 25, 0],
    ['Abhisheka Seva', 26, 0], ['Gau Seva', 134, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Sri Krishna Janmashtami', subCategoryId: 10, code: 'SKJ', subs: [
    ['Tulasi Archana Seva', 72, 0], ['Jhulan Seva', 73, 0], ['Naivedya Seva', 74, 0], ['Vastra Abharana Seva', 75, 0],
    ['Mukhya Yajamana Seva', 76, 0], ['Udaya Asthamana Seva', 77, 0], ['Gau Seva', 102, 1], ['Annadana Seva', 27, 1],
    ['Mandapa Seva', 28, 0], ['Pushpalankara Seva', 29, 0], ['Yajamana Seva', 30, 0], ['Abhisheka Seva', 31, 0],
    ['Makhan Mishri Seva', 93, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Sri Nityananada Trayodashi', subCategoryId: 11, code: 'NITY', subs: [
    ['Annadana Seva', 32, 1], ['Mandapa Seva', 33, 0], ['Pushpalankara Seva', 34, 0], ['Yajamana Seva', 35, 0],
    ['Abhisheka Seva', 36, 0], ['Gau Seva', 136, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Sri Radhastami', subCategoryId: 12, code: 'RADH', subs: [
    ['Gau Seva', 137, 1], ['Special Cake Offering Seva', 103, 0], ['Annadana Seva', 37, 1], ['Mandapa Seva', 38, 0],
    ['Pushpalankara Seva', 39, 0], ['Yajamana Seva', 40, 0], ['Abhisheka Seva', 50, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Sri Ramanavami', subCategoryId: 13, code: 'SRN', subs: [
    ['Abhisheka Seva', 51, 0], ['Annadana Seva', 41, 1], ['Mandapa Seva', 42, 0], ['Pushpalankara Seva', 43, 0],
    ['Yajamana Seva', 44, 0], ['Rama Taraka Yajna Seva', 45, 0], ['Sri Sita Rama Kalyana Seva', 123, 0],
    ['Gau Seva', 138, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Intinta Nitai Gauranga', subCategoryId: 14, code: 'ING', subs: [['Annadana Seva', 46, 1]] },
  { category: 'Book Distribution Donation', categoryId: 4, subCategory: 'Bhagavad Gita Distribution', subCategoryId: 15, code: 'BD', subs: null },
  { category: 'Cultural Complex Donation', categoryId: 5, subCategory: 'Square Feet Seva', subCategoryId: 16, code: 'CCD', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - DA', subCategoryId: 38, code: 'MNS-DA', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - MADA', subCategoryId: 39, code: 'MNS-MADA', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - VDA', subCategoryId: 40, code: 'MNS-VDA (BFP)', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Srila Prabhupada Disappearance Day', subCategoryId: 74, code: 'SPDD', subs: [
    ['Annadana Seva', 68, 1], ['Abhisheka Seva', 69, 0] ] },
  { category: 'Annadanam', categoryId: 1, subCategory: 'Karthika Annadanam', subCategoryId: 75, code: 'KAN', subs: null },
  { category: 'Go Seva', categoryId: 20, subCategory: 'Cow Protection', subCategoryId: 76, code: 'GOSE', subs: null },
  { category: 'Cultural Education', categoryId: 21, subCategory: 'Bala Sanskrti', subCategoryId: 79, code: 'BSKT', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Vyasa Puja', subCategoryId: 80, code: 'VYPJ', subs: [
    ['Annadana Seva', 70, 1], ['Abhisheka Seva', 71, 0] ] },
  { category: 'Annadanam', categoryId: 1, subCategory: 'Brahamana Vaishnava Seva', subCategoryId: 85, code: 'ANVS', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Laksha Deepotsava', subCategoryId: 86, code: 'LAKD', subs: [
    ['Annadana Seva', 81, 1], ['Annakuta Seva', 82, 0], ['Deepalankara Seva', 83, 0], ['Deeparadhana Seva', 84, 0],
    ['Mantapa Seva', 85, 0], ['Naivedya Seva', 86, 0], ['Pushpalankara Seva', 87, 0], ['Yajamana Seva', 88, 0],
    ['Vastrabharana Seva', 89, 0], ['Gau Seva', 139, 1] ] },
  { category: 'Cultural Education', categoryId: 21, subCategory: 'Gita For Youth', subCategoryId: 87, code: 'GFYT', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - MUDA', subCategoryId: 88, code: 'MNS-MUDA (SFP)', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - YJ', subCategoryId: 89, code: 'MNS-YJ (GFP)', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - MAYJ', subCategoryId: 90, code: 'MNS-MAYJ (PFP)', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - VYJ', subCategoryId: 91, code: 'MNS-VYJ (DFP)', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - MUYJ', subCategoryId: 92, code: 'MNS-MUYJ (AFP)', subs: null },
  { category: CP, categoryId: 3, subCategory: 'CHANDANOTSAVAM', subCategoryId: 93, code: 'CHAN', subs: [
    ['Annadana Seva', 91, 1], ['Panakam Seva', 92, null] ] },
  { category: PD, categoryId: 10, subCategory: 'Promotion of Art & Culture', subCategoryId: 95, code: 'CSR-PAC', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - DS', subCategoryId: 96, code: 'MNS-DS', subs: null },
  { category: PD, categoryId: 10, subCategory: 'CULTURAL COMPLEX DONATION - DK', subCategoryId: 97, code: 'MNS-DK', subs: null },
  { category: GD, categoryId: 2, subCategory: 'General Square Feet Seva', subCategoryId: 99, code: 'GSQF', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Ugadi', subCategoryId: 100, code: 'UGAD', subs: [
    ['Annadana Seva', 94, 1], ['Homam Seva', 95, 0], ['Ashottara Seva', 96, 0] ] },
  { category: GD, categoryId: 2, subCategory: 'Square Feet Seva CONG', subCategoryId: 102, code: 'SQFTCNF', subs: null },
  { category: GD, categoryId: 2, subCategory: 'Brick Seva', subCategoryId: 103, code: 'BSC', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Ratha Yatra', subCategoryId: 104, code: 'RATH', subs: [
    ['Annadana Seva', 97, 1], ['Naivedya Seva', 98, 0], ['Pushpalankara Seva', 99, 0], ['Vishesha Alankara Seva', 100, 0],
    ['Jagannatha Archana Seva', 101, 0], ['Gau Seva', 140, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Vijayadashami', subCategoryId: 106, code: 'VIJD', subs: [
    ['Gau Seva', 141, 1], ['Yajamana Seva', 104, 0], ['Pushpalankara Seva', 105, 0], ['Mantapa Seva', 106, 0],
    ['Vastrabharana Seva', 107, 0], ['Annadana Seva', 108, 1], ['Vijayadashami Homam', 109, 0] ] },
  { category: GD, categoryId: 2, subCategory: 'VANABHOJANAM', subCategoryId: 107, code: 'VNBJ', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Pranapratishta', subCategoryId: 108, code: 'PRAN', subs: [
    ['Mahakumbha Abhisheka Seva', 110, 0], ['Prathama Ashtottara Archana Seva', 111, 0], ['Rajbhog (Chappanbhog) Seva', 112, 0],
    ['Divyabharana Seva', 113, 0], ['Annadana Seva', 114, 1], ['Divya Vastra Seva', 115, 0], ['Silver Naivedya Set', 116, 0],
    ['Silver Arati Set', 117, 0], ['Pancha Patra Set', 118, 0], ['Shatari Seva', 119, 0], ['Tiruvedi Seva', 120, 0],
    ['Prabhavali Seva', 121, 0], ['Brass Items Seva', 122, 0], ['Gau Seva', 142, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Akshaya Tritiya', subCategoryId: 109, code: 'AKSH', subs: [
    ['Gau Seva', 143, 1], ['Annadana Seva', 124, 1], ['Mahalakshmi SahasraNama Yagna Seva', 125, 0],
    ['Ashttottara & Go Seva', 126, 0], ['Panakam Seva', 127, 0] ] },
  { category: CP, categoryId: 3, subCategory: 'Jhulan Yatra', subCategoryId: 110, code: 'JHUL', subs: [
    ['Jhulan Utsav Seva', 128, 0], ['Annadana Seva', 129, 1] ] },
  // Sankranti (sub category 111): ids 144 and 145 were cut off in the screenshots and are not here.
  { category: CP, categoryId: 3, subCategory: 'Sankranti', subCategoryId: 111, code: 'SANK', subs: [
    ['Pushpalankara Seva', 146, 0], ['Makara Sankranti Homa Seva', 147, 0], ['Annadana Seva', 148, 1] ] },
  { category: GD, categoryId: 2, subCategory: 'Golden Brick Seva', subCategoryId: 112, code: 'GBSC', subs: null },
  { category: CP, categoryId: 3, subCategory: 'Prana Pratishta Varshikotsava', subCategoryId: 113, code: 'PPVK', subs: [
    ['Panchasukta Homa Seva', 149, 0], ['Abhisheka Seva', 150, 0], ['Annadana Seva', 151, 1], ['Gau Seva', 152, 1] ] },
  { category: CP, categoryId: 3, subCategory: 'Pranapratishta Kakinada', subCategoryId: 114, code: 'PRANK', subs: [
    ['Moola Virat Vigraha Seva', 153, 0], ['Srivari Mandapam Seva', 154, 0], ['Utsava Vigraha Seva', 155, 0],
    ['Srivari Tiruvedi Seva', 156, 0], ['Vastrabharana Seva', 157, 0], ['Makaratoranam Seva', 158, 0],
    ['Archana Sannahaka Mandira Seva', 159, 0], ['Nitya Puja Samagri Seva', 160, 0], ['Srivari Pallaki Seva', 161, 0],
    ['Kalasha Abhisheka Seva', 162, 0], ['Archaka Nivas Seva', 163, 0], ['Srivari Pakashala Patra Seva', 164, 0],
    ['Mandira Alankara Seva', 165, 0], ['Annadana Seva', 166, 1] ] },
];

/** The seed flattened to one row per catalog entry. */
export function seedRows() {
  const rows: {
    category: string; categoryId: number; subCategory: string; subCategoryId: number; code: string;
    subCode: string | null; subCodeId: number | null; taxExempted: boolean | null;
  }[] = [];
  for (const g of SEVA_SEED) {
    if (!g.subs) {
      rows.push({ category: g.category, categoryId: g.categoryId, subCategory: g.subCategory, subCategoryId: g.subCategoryId, code: g.code, subCode: null, subCodeId: null, taxExempted: null });
    } else {
      for (const [name, codeId, tax] of g.subs) {
        rows.push({ category: g.category, categoryId: g.categoryId, subCategory: g.subCategory, subCategoryId: g.subCategoryId, code: g.code, subCode: name, subCodeId: codeId, taxExempted: tax === null ? null : tax === 1 });
      }
    }
  }
  return rows;
}
