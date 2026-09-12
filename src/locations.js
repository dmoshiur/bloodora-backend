// ==================== Bangladesh Locations - Complete Data ====================
// Mirrors Flask get_locations() but as Node module for ultra-fast access
export const divisions = [
  { id: "1", name: "Barishal" },
  { id: "2", name: "Chattogram" },
  { id: "3", name: "Dhaka" },
  { id: "4", name: "Khulna" },
  { id: "5", name: "Rajshahi" },
  { id: "6", name: "Rangpur" },
  { id: "7", name: "Sylhet" },
  { id: "8", name: "Mymensingh" }
];

export const districts = [
  { id: "1", division_id: "1", name: "Barguna" }, { id: "2", division_id: "1", name: "Barishal" },
  { id: "3", division_id: "1", name: "Bhola" }, { id: "4", division_id: "1", name: "Jhalokati" },
  { id: "5", division_id: "1", name: "Patuakhali" }, { id: "6", division_id: "1", name: "Pirojpur" },
  { id: "7", division_id: "2", name: "Bandarban" }, { id: "8", division_id: "2", name: "Brahmanbaria" },
  { id: "9", division_id: "2", name: "Chandpur" }, { id: "10", division_id: "2", name: "Chattogram" },
  { id: "11", division_id: "2", name: "Comilla" }, { id: "12", division_id: "2", name: "Cox's Bazar" },
  { id: "13", division_id: "2", name: "Feni" }, { id: "14", division_id: "2", name: "Khagrachhari" },
  { id: "15", division_id: "2", name: "Lakshmipur" }, { id: "16", division_id: "2", name: "Noakhali" },
  { id: "17", division_id: "2", name: "Rangamati" }, { id: "18", division_id: "3", name: "Dhaka" },
  { id: "19", division_id: "3", name: "Faridpur" }, { id: "20", division_id: "3", name: "Gazipur" },
  { id: "21", division_id: "3", name: "Gopalganj" }, { id: "22", division_id: "3", name: "Kishoreganj" },
  { id: "23", division_id: "3", name: "Madaripur" }, { id: "24", division_id: "3", name: "Manikganj" },
  { id: "25", division_id: "3", name: "Munshiganj" }, { id: "26", division_id: "3", name: "Narayanganj" },
  { id: "27", division_id: "3", name: "Narsingdi" }, { id: "28", division_id: "3", name: "Rajbari" },
  { id: "29", division_id: "3", name: "Shariatpur" }, { id: "30", division_id: "3", name: "Tangail" },
  { id: "31", division_id: "4", name: "Bagerhat" }, { id: "32", division_id: "4", name: "Chuadanga" },
  { id: "33", division_id: "4", name: "Jessore" }, { id: "34", division_id: "4", name: "Jhenaidah" },
  { id: "35", division_id: "4", name: "Khulna" }, { id: "36", division_id: "4", name: "Kushtia" },
  { id: "37", division_id: "4", name: "Magura" }, { id: "38", division_id: "4", name: "Meherpur" },
  { id: "39", division_id: "4", name: "Narail" }, { id: "40", division_id: "4", name: "Satkhira" },
  { id: "41", division_id: "5", name: "Bogura" }, { id: "42", division_id: "5", name: "Chapainawabganj" },
  { id: "43", division_id: "5", name: "Joypurhat" }, { id: "44", division_id: "5", name: "Naogaon" },
  { id: "45", division_id: "5", name: "Natore" }, { id: "46", division_id: "5", name: "Pabna" },
  { id: "47", division_id: "5", name: "Rajshahi" }, { id: "48", division_id: "5", name: "Sirajganj" },
  { id: "49", division_id: "6", name: "Dinajpur" }, { id: "50", division_id: "6", name: "Gaibandha" },
  { id: "51", division_id: "6", name: "Kurigram" }, { id: "52", division_id: "6", name: "Lalmonirhat" },
  { id: "53", division_id: "6", name: "Nilphamari" }, { id: "54", division_id: "6", name: "Panchagarh" },
  { id: "55", division_id: "6", name: "Rangpur" }, { id: "56", division_id: "6", name: "Thakurgaon" },
  { id: "57", division_id: "7", name: "Habiganj" }, { id: "58", division_id: "7", name: "Moulvibazar" },
  { id: "59", division_id: "7", name: "Sunamganj" }, { id: "60", division_id: "7", name: "Sylhet" },
  { id: "61", division_id: "8", name: "Jamalpur" }, { id: "62", division_id: "8", name: "Mymensingh" },
  { id: "63", division_id: "8", name: "Netrokona" }, { id: "64", division_id: "8", name: "Sherpur" }
];

// Full Bangladesh nested structure for cascading dropdowns (JS)
export const bangladeshData = {
  "Barishal": {
    "Barguna": ["Amtali","Bamna","Barguna Sadar","Betagi","Patharghata","Taltali"],
    "Barishal": ["Agailjhara","Babuganj","Bakerganj","Banaripara","Barishal Sadar","Gaurnadi","Hizla","Mehendiganj","Muladi","Wazirpur"],
    "Bhola": ["Bhola Sadar","Burhanuddin","Char Fasson","Daulatkhan","Lalmohan","Manpura","Tazumuddin"],
    "Jhalokati": ["Jhalokati Sadar","Kathalia","Nalchity","Rajapur"],
    "Patuakhali": ["Bauphal","Dashmina","Dumki","Galachipa","Kalapara","Mirzaganj","Patuakhali Sadar","Rangabali"],
    "Pirojpur": ["Bhandaria","Kawkhali","Mathbaria","Nazirpur","Nesarabad","Pirojpur Sadar","Zianagar"]
  },
  "Chattogram": {
    "Bandarban": ["Ali Kadam","Bandarban Sadar","Lama","Naikhongchhari","Rowangchhari","Ruma","Thanchi"],
    "Brahmanbaria": ["Akhaura","Bancharampur","Brahmanbaria Sadar","Kasba","Nabinagar","Nasirnagar","Sarail","Ashuganj","Bijoynagar"],
    "Chandpur": ["Chandpur Sadar","Faridganj","Haimchar","Haziganj","Kachua","Matlab Dakshin","Matlab Uttar","Shahrasti"],
    "Chattogram": ["Anwara","Banshkhali","Boalkhali","Chandanaish","Fatikchhari","Hathazari","Lohagara","Mirsharai","Patiya","Rangunia","Raozan","Sandwip","Satkania","Sitakunda","Chattogram Sadar"],
    "Comilla": ["Barura","Brahmanpara","Burichang","Chandina","Chauddagram","Comilla Sadar","Comilla Sadar Dakshin","Daudkandi","Debidwar","Homna","Laksam","Lalmai","Meghna","Monohorgonj","Muradnagar","Nangalkot","Titas"],
    "Cox's Bazar": ["Chakaria","Cox's Bazar Sadar","Kutubdia","Maheshkhali","Pekua","Ramu","Teknaf","Ukhia"],
    "Feni": ["Chhagalnaiya","Daganbhuiyan","Feni Sadar","Fulgazi","Parshuram","Sonagazi"],
    "Khagrachhari": ["Dighinala","Khagrachhari Sadar","Lakshmichhari","Mahalchhari","Manikchhari","Matiranga","Panchhari","Ramgarh"],
    "Lakshmipur": ["Kamalnagar","Lakshmipur Sadar","Raipur","Ramganj","Ramgati"],
    "Noakhali": ["Begumganj","Chatkhil","Companiganj","Hatiya","Noakhali Sadar","Senbagh","Sonaimuri","Subarnachar"],
    "Rangamati": ["Baghaichhari","Barkal","Belaichhari","Juraichhari","Kaptai","Kawkhali","Langadu","Naniyachar","Rajasthali","Rangamati Sadar"]
  },
  "Dhaka": {
    "Dhaka": ["Dhamrai","Dohar","Keraniganj","Nawabganj","Savar","Tejgaon","Gulshan","Mirpur","Motijheel","Uttara","Dhaka Dakshin","Dhaka Uttar"],
    "Faridpur": ["Alfadanga","Bhanga","Boalmari","Char Bhadrasan","Faridpur Sadar","Madhukhali","Nagarkanda","Sadarpur","Saltha"],
    "Gazipur": ["Gazipur Sadar","Kaliakair","Kaliganj","Kapasia","Sreepur"],
    "Gopalganj": ["Gopalganj Sadar","Kashiani","Kotalipara","Muksudpur","Tungipara"],
    "Kishoreganj": ["Austagram","Bajitpur","Bhairab","Hossainpur","Itna","Karimganj","Katiadi","Kishoreganj Sadar","Kuliarchar","Mithamain","Nikli","Pakundia","Tarail"],
    "Madaripur": ["Kalkini","Madaripur Sadar","Rajoir","Shibchar"],
    "Manikganj": ["Daulatpur","Ghior","Harirampur","Manikganj Sadar","Saturia","Shivalaya","Singair"],
    "Munshiganj": ["Gazaria","Lohajang","Munshiganj Sadar","Serajdikhan","Sreenagar","Tongibari"],
    "Narayanganj": ["Araihazar","Bandar","Narayanganj Sadar","Rupganj","Sonargaon"],
    "Narsingdi": ["Belabo","Monohardi","Narsingdi Sadar","Palash","Raipura","Shibpur"],
    "Rajbari": ["Baliakandi","Goalandaghat","Kalukhali","Pangsha","Rajbari Sadar"],
    "Shariatpur": ["Bhedarganj","Damudya","Gosairhat","Naria","Shariatpur Sadar","Zajira"],
    "Tangail": ["Basail","Bhuapur","Delduar","Ghatail","Gopalpur","Kalihati","Madhupur","Mirzapur","Nagarpur","Sakhipur","Tangail Sadar","Dhanbari"]
  },
  "Khulna": {
    "Bagerhat": ["Bagerhat Sadar","Chitalmari","Fakirhat","Kachua","Mollahat","Mongla","Morrelganj","Rampal","Sarankhola"],
    "Chuadanga": ["Alamdanga","Chuadanga Sadar","Damurhuda","Jibannagar"],
    "Jessore": ["Abhaynagar","Bagherpara","Chaugachha","Jhikargachha","Keshabpur","Jessore Sadar","Manirampur","Sharsha"],
    "Jhenaidah": ["Harinakunda","Jhenaidah Sadar","Kaliganj","Kotchandpur","Maheshpur","Shailkupa"],
    "Khulna": ["Batiaghata","Dacope","Dighalia","Dumuria","Koyra","Paikgachha","Phultala","Rupsa","Terokhada"],
    "Kushtia": ["Bheramara","Daulatpur","Khoksa","Kumarkhali","Kushtia Sadar","Mirpur"],
    "Magura": ["Magura Sadar","Mohammadpur","Shalikha","Sreepur"],
    "Meherpur": ["Gangni","Meherpur Sadar","Mujibnagar"],
    "Narail": ["Kalia","Lohagara","Narail Sadar"],
    "Satkhira": ["Assasuni","Debhata","Kalaroa","Kaliganj","Satkhira Sadar","Shyamnagar","Tala"]
  },
  "Rajshahi": {
    "Bogura": ["Adamdighi","Bogura Sadar","Dhunat","Dupchanchia","Gabtali","Kahaloo","Nandigram","Sariakandi","Shajahanpur","Sherpur","Shibganj","Sonatala"],
    "Chapainawabganj": ["Bholahat","Gomastapur","Nachole","Nawabganj Sadar","Shibganj"],
    "Joypurhat": ["Akkelpur","Joypurhat Sadar","Kalai","Khetlal","Panchbibi"],
    "Naogaon": ["Atrai","Badalgachhi","Dhamoirhat","Manda","Mahadevpur","Naogaon Sadar","Niamatpur","Patnitala","Porsha","Raninagar","Sapahar"],
    "Natore": ["Bagatipara","Baraigram","Gurudaspur","Lalpur","Natore Sadar","Singra"],
    "Pabna": ["Atgharia","Bera","Bhangura","Chatmohar","Faridpur","Ishwardi","Pabna Sadar","Santhia","Sujanagar"],
    "Rajshahi": ["Bagha","Bagmara","Charghat","Durgapur","Godagari","Mohanpur","Paba","Puthia","Rajshahi Sadar","Tanore"],
    "Sirajganj": ["Belkuchi","Chauhali","Kamarkhanda","Kazipur","Raiganj","Shahjadpur","Sirajganj Sadar","Tarash","Ullahpara"]
  },
  "Rangpur": {
    "Dinajpur": ["Birampur","Birganj","Biral","Bochaganj","Chirirbandar","Dinajpur Sadar","Fulbari","Ghoraghat","Hakimpur","Kaharole","Khansama","Nawabganj","Parbatipur"],
    "Gaibandha": ["Fulchhari","Gaibandha Sadar","Gobindaganj","Palashbari","Sadullapur","Saghata","Sundarganj"],
    "Kurigram": ["Bhurungamari","Char Rajibpur","Chilmari","Kurigram Sadar","Nageshwari","Phulbari","Rajarhat","Raomari","Ulipur"],
    "Lalmonirhat": ["Aditmari","Hatibandha","Kaliganj","Lalmonirhat Sadar","Patgram"],
    "Nilphamari": ["Dimla","Domar","Jaldhaka","Kishoreganj","Nilphamari Sadar","Saidpur"],
    "Panchagarh": ["Atwari","Boda","Debiganj","Panchagarh Sadar","Tetulia"],
    "Rangpur": ["Badarganj","Gangachara","Kaunia","Mithapukur","Pirgachha","Pirganj","Rangpur Sadar","Taraganj"],
    "Thakurgaon": ["Baliadangi","Haripur","Pirganj","Ranisankail","Thakurgaon Sadar"]
  },
  "Sylhet": {
    "Habiganj": ["Ajmiriganj","Bahubal","Baniachong","Chunarughat","Habiganj Sadar","Lakhai","Madhabpur","Nabiganj","Shayestaganj"],
    "Moulvibazar": ["Barlekha","Juri","Kamalganj","Kulaura","Moulvibazar Sadar","Rajnagar","Sreemangal"],
    "Sunamganj": ["Bishwamvarpur","Chhatak","Derai","Dharmapasha","Dowarabazar","Jagannathpur","Jamalganj","Sulla","Sunamganj Sadar","Tahirpur"],
    "Sylhet": ["Balaganj","Beanibazar","Bishwanath","Companiganj","Fenchuganj","Golapganj","Gowainghat","Jaintiapur","Kanaighat","Sylhet Sadar","Zakiganj","Dakshin Surma"]
  },
  "Mymensingh": {
    "Jamalpur": ["Baksiganj","Dewanganj","Islampur","Jamalpur Sadar","Madarganj","Melandaha","Sarishabari"],
    "Mymensingh": ["Bhaluka","Dhobaura","Fulbaria","Gaffargaon","Gauripur","Haluaghat","Ishwarganj","Mymensingh Sadar","Muktagachha","Nandail","Phulpur","Trishal","Gafargaon"],
    "Netrokona": ["Atpara","Barhatta","Durgapur","Khaliajuri","Kalmakanda","Madan","Mohanganj","Netrokona Sadar","Purbadhala"],
    "Sherpur": ["Jhenaigati","Nakla","Nalitabari","Sherpur Sadar","Sreebardi"]
  }
};

export function getLocations() {
  return { divisions, districts, upazilas: [] }; // kept for compatibility
}

export function calculateAge(dob) {
  if (!dob) return null;
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}
